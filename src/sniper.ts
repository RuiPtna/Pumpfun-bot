import WebSocket from "ws";
import { Connection, Keypair } from "@solana/web3.js";
import { executeTrade } from "./trade";
import { passesEntryFilters, StrategyConfig, TokenSnapshot } from "./strategy";
import { logTrade, getOpenPositions, saveOpenPosition, closePosition, OpenPosition } from "./db";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

/**
 * Gère, pour UN utilisateur/wallet donné :
 * - l'écoute des nouveaux tokens pump.fun et l'achat automatique si les filtres passent
 * - le suivi de prix des positions ouvertes pour déclencher stop-loss / take-profit
 *
 * Limitation volontaire : conçu pour un usage mono-utilisateur (le tien).
 * Pour gérer plusieurs utilisateurs en parallèle, il faudrait une instance
 * de AutoTrader par utilisateur, avec des WebSockets/positions séparées.
 */
export class AutoTrader {
  private ws: WebSocket | null = null;
  private newTokenTimestamps = new Map<string, number>();
  private notify: (msg: string) => void;

  constructor(
    private telegramId: number,
    private connection: Connection,
    private signer: Keypair,
    private config: StrategyConfig,
    notifyFn: (msg: string) => void
  ) {
    this.notify = notifyFn;
  }

  start(): void {
    if (this.ws) return; // déjà démarré
    this.ws = new WebSocket(PUMPPORTAL_WS);

    this.ws.on("open", () => {
      this.ws?.send(JSON.stringify({ method: "subscribeNewToken" }));
      // Ré-abonne aux trades des positions déjà ouvertes (redémarrage du bot)
      const openPositions = getOpenPositions(this.telegramId);
      if (openPositions.length > 0) {
        this.ws?.send(
          JSON.stringify({
            method: "subscribeTokenTrade",
            keys: openPositions.map((p) => p.mint),
          })
        );
      }
      this.notify("🟢 Auto-trading démarré : écoute des nouveaux tokens en cours...");
    });

    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
    this.ws.on("error", (err) => this.notify(`⚠️ Erreur WebSocket : ${err.message}`));
    this.ws.on("close", () => {
      this.notify("🔴 Connexion au flux de données perdue, reconnexion dans 5s...");
      this.ws = null;
      setTimeout(() => this.start(), 5000);
    });
  }

  stop(): void {
    this.ws?.close();
    this.ws = null;
    this.notify("⏹️ Auto-trading arrêté.");
  }

  private async handleMessage(raw: string): Promise<void> {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // Nouveau token créé
    if (data.txType === "create" && data.mint) {
      this.newTokenTimestamps.set(data.mint, Date.now());
      return;
    }

    // Trade sur un token qu'on suit (nouveau candidat OU position ouverte)
    if (data.txType === "buy" || data.txType === "sell") {
      const mint = data.mint;
      if (!mint) return;

      const openPosition = getOpenPositions(this.telegramId).find((p) => p.mint === mint);
      if (openPosition) {
        await this.checkExitConditions(openPosition, data);
        return;
      }

      await this.maybeEnterPosition(mint, data);
    }
  }

  private async maybeEnterPosition(mint: string, tradeEvent: any): Promise<void> {
    if (!this.config.autoTradeEnabled) return;

    const openPositions = getOpenPositions(this.telegramId);
    if (openPositions.length >= this.config.maxOpenPositions) return;
    if (openPositions.some((p) => p.mint === mint)) return;

    const createdAt = this.newTokenTimestamps.get(mint);
    if (!createdAt) return; // on ne connaît pas l'âge du token, on skip par prudence

    // NB: PumpPortal ne donne pas directement "creatorHoldingPercent" ni
    // "uniqueBuyers" dans le flux de base — à affiner en croisant avec
    // getTokenLargestAccounts (RPC Solana) si tu veux des filtres plus fins.
    const snapshot: TokenSnapshot = {
      mint,
      createdAt,
      creatorHoldingPercent: tradeEvent.creatorHoldingPercent ?? 0,
      uniqueBuyers: tradeEvent.uniqueBuyers ?? this.config.minUniqueBuyers, // valeur neutre si absente
    };

    if (!passesEntryFilters(snapshot, this.config)) return;

    try {
      this.notify(`🎯 Signal d'achat détecté sur ${mint.slice(0, 8)}... — exécution...`);
      const signature = await executeTrade(this.connection, this.signer, {
        action: "buy",
        mint,
        amount: this.config.positionSizeSol,
        denominatedInSol: true,
        slippagePercent: this.config.slippagePercent,
        priorityFeeSol: this.config.priorityFeeSol,
      });

      const entryPriceSol = tradeEvent.solAmount && tradeEvent.tokenAmount
        ? tradeEvent.solAmount / tradeEvent.tokenAmount
        : 0;

      const position: OpenPosition = {
        telegramId: this.telegramId,
        mint,
        entryPriceSol,
        positionSizeSol: this.config.positionSizeSol,
        remainingPercent: 100,
        takeProfitLevelsHit: [],
        openedAt: new Date().toISOString(),
      };
      saveOpenPosition(position);
      logTrade({
        telegramId: this.telegramId,
        action: "buy",
        mint,
        amountSol: this.config.positionSizeSol,
        signature,
        timestamp: new Date().toISOString(),
      });

      this.ws?.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
      this.notify(`✅ Achat auto exécuté sur ${mint.slice(0, 8)}...\nhttps://solscan.io/tx/${signature}`);
    } catch (err) {
      this.notify(`❌ Échec achat auto sur ${mint.slice(0, 8)}... : ${(err as Error).message}`);
    }
  }

  private async checkExitConditions(position: OpenPosition, tradeEvent: any): Promise<void> {
    if (!tradeEvent.solAmount || !tradeEvent.tokenAmount || position.entryPriceSol <= 0) return;

    const currentPrice = tradeEvent.solAmount / tradeEvent.tokenAmount;
    const gainPercent = ((currentPrice - position.entryPriceSol) / position.entryPriceSol) * 100;

    // Stop-loss : on vend tout ce qu'il reste
    if (gainPercent <= this.config.stopLossPercent) {
      await this.exitPosition(position, "100%", `🛑 Stop-loss déclenché (${gainPercent.toFixed(1)}%)`);
      return;
    }

    // Take-profit par paliers
    for (const level of this.config.takeProfitLevels) {
      const alreadyHit = position.takeProfitLevelsHit.includes(level.gainPercent);
      if (!alreadyHit && gainPercent >= level.gainPercent) {
        position.takeProfitLevelsHit.push(level.gainPercent);
        await this.exitPosition(
          position,
          `${level.sellPercent}%`,
          `🎉 Take-profit +${level.gainPercent}% atteint, vente de ${level.sellPercent}%`
        );
      }
    }
  }

  private async exitPosition(position: OpenPosition, sellAmount: string, reason: string): Promise<void> {
    try {
      this.notify(`${reason} sur ${position.mint.slice(0, 8)}...`);
      const signature = await executeTrade(this.connection, this.signer, {
        action: "sell",
        mint: position.mint,
        amount: sellAmount,
        denominatedInSol: false,
        slippagePercent: this.config.slippagePercent,
        priorityFeeSol: this.config.priorityFeeSol,
      });

      logTrade({
        telegramId: this.telegramId,
        action: "sell",
        mint: position.mint,
        signature,
        timestamp: new Date().toISOString(),
      });

      const soldPercent = parseInt(sellAmount, 10);
      position.remainingPercent -= soldPercent;
      if (position.remainingPercent <= 0) {
        closePosition(this.telegramId, position.mint);
      } else {
        saveOpenPosition(position);
      }

      this.notify(`✅ Vente exécutée.\nhttps://solscan.io/tx/${signature}`);
    } catch (err) {
      this.notify(`❌ Échec de la vente sur ${position.mint.slice(0, 8)}... : ${(err as Error).message}`);
    }
  }
}