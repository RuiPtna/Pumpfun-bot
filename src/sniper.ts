import WebSocket from "ws";
import { Connection, Keypair } from "@solana/web3.js";
import { executeTrade } from "./trade";
import { StrategyParams } from "./config";
import { TokenWatch, createTokenWatch, scoreToken, passesHardFilters } from "./scoring";
import { getSolPriceUsd, PUMPFUN_TOTAL_SUPPLY } from "./priceFeed";
import { simulateBuy, simulateSell } from "./paperTrading";
import {
  logTrade,
  getOpenPositions,
  saveOpenPosition,
  closePosition,
  logRejectedToken,
  logClosedTrade,
  getBotState,
  saveBotState,
  OpenPosition,
} from "./db";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

export class AutoTrader {
  private ws: WebSocket | null = null;
  private watches = new Map<string, TokenWatch>();
  private evalIntervals = new Map<string, NodeJS.Timeout>();
  private peakPrices = new Map<string, number>();
  private notify: (msg: string) => void;

  constructor(
    private telegramId: number,
    private connection: Connection,
    private signer: Keypair,
    private params: StrategyParams,
    notifyFn: (msg: string) => void
  ) {
    this.notify = notifyFn;
  }

  start(): void {
    if (this.ws) return;
    this.ws = new WebSocket(PUMPPORTAL_WS);

    this.ws.on("open", () => {
      this.ws?.send(JSON.stringify({ method: "subscribeNewToken" }));
      const openPositions = getOpenPositions(this.telegramId);
      if (openPositions.length > 0) {
        this.ws?.send(JSON.stringify({ method: "subscribeTokenTrade", keys: openPositions.map((p) => p.mint) }));
      }
      const mode = this.params.liveTrading ? "🔴 LIVE (argent réel)" : "📝 PAPER (simulation)";
      this.notify(`🟢 Auto-trading démarré — mode ${mode}`);
    });

    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
    this.ws.on("error", (err) => this.notify(`⚠️ Erreur WebSocket : ${err.message}`));
    this.ws.on("close", () => {
      this.notify("🔴 Connexion perdue, reconnexion dans 5s...");
      this.ws = null;
      setTimeout(() => this.start(), 5000);
    });
  }

  stop(): void {
    this.evalIntervals.forEach((t) => clearInterval(t));
    this.evalIntervals.clear();
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

    if (data.txType === "create" && data.mint) {
      this.beginWatching(data.mint);
      return;
    }

    if (data.txType === "buy" || data.txType === "sell") {
      const mint = data.mint;
      if (!mint) return;

      const openPosition = getOpenPositions(this.telegramId).find((p) => p.mint === mint);
      if (openPosition) {
        await this.updatePositionAndCheckExit(openPosition, data);
        return;
      }

      const watch = this.watches.get(mint);
      if (watch && !watch.decided) {
        this.recordTradeOnWatch(watch, data);
      }
    }
  }

  private beginWatching(mint: string): void {
    const state = getBotState(this.telegramId, this.params.startingCapitalUsd);
    state.tokensScanned += 1;
    saveBotState(this.telegramId, state);

    const watch = createTokenWatch(mint, Date.now());
    this.watches.set(mint, watch);
    this.ws?.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));

    const interval = setInterval(() => this.evaluateWatch(mint), 20_000);
    this.evalIntervals.set(mint, interval);

    setTimeout(() => this.finalizeWatchIfExpired(mint), (this.params.maxAgeMinutes * 60 + 30) * 1000);
  }

  private recordTradeOnWatch(watch: TokenWatch, tradeEvent: any): void {
    if (tradeEvent.txType === "buy") {
      watch.buyCount += 1;
      if (tradeEvent.traderPublicKey) watch.uniqueBuyers.add(tradeEvent.traderPublicKey);
    } else {
      watch.sellCount += 1;
      if (tradeEvent.traderPublicKey) watch.uniqueSellers.add(tradeEvent.traderPublicKey);
    }
    if (typeof tradeEvent.marketCapSol === "number") {
      getSolPriceUsd().then((solPrice) => {
        watch.mcHistory.push({ t: Date.now(), marketCapUsd: tradeEvent.marketCapSol * solPrice });
        if (watch.mcHistory.length > 50) watch.mcHistory.shift();
      });
    }
  }

  private async evaluateWatch(mint: string): Promise<void> {
    const watch = this.watches.get(mint);
    if (!watch || watch.decided) return;

    const solPrice = await getSolPriceUsd();
    const lastMc = watch.mcHistory[watch.mcHistory.length - 1]?.marketCapUsd;
    if (!lastMc) return;

    const hardFilter = passesHardFilters(watch, lastMc, this.params);
    if (!hardFilter.ok) {
      if (hardFilter.reason === "trop jeune") return;
      this.rejectWatch(mint, hardFilter.reason!, 0);
      return;
    }

    const score = scoreToken(watch, lastMc);
    if (score.total < this.params.minEntryScore) return;

    await this.tryEnter(mint, watch, lastMc, score.total, solPrice);
  }

  private finalizeWatchIfExpired(mint: string): void {
    const watch = this.watches.get(mint);
    if (!watch || watch.decided) return;
    this.rejectWatch(mint, "fenêtre d'observation expirée sans setup validé", 0);
  }

  private rejectWatch(mint: string, reason: string, score: number): void {
    const watch = this.watches.get(mint);
    if (watch) watch.decided = true;

    const interval = this.evalIntervals.get(mint);
    if (interval) clearInterval(interval);
    this.evalIntervals.delete(mint);
    this.ws?.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [mint] }));

    const state = getBotState(this.telegramId, this.params.startingCapitalUsd);
    state.tokensRejected += 1;
    saveBotState(this.telegramId, state);
    logRejectedToken({ telegramId: this.telegramId, mint, reason, score, timestamp: new Date().toISOString() });

    this.watches.delete(mint);
  }

  private async tryEnter(
    mint: string,
    watch: TokenWatch,
    marketCapUsd: number,
    score: number,
    solPriceUsd: number
  ): Promise<void> {
    const state = getBotState(this.telegramId, this.params.startingCapitalUsd);

    const today = new Date().toISOString().slice(0, 10);
    if (state.dailyDate !== today) {
      state.dailyDate = today;
      state.dailyStartCapitalUsd = this.params.liveTrading
        ? await this.getRealCapitalUsd(solPriceUsd)
        : state.paperCapitalUsd;
    }

    const currentCapitalUsd = this.params.liveTrading
      ? await this.getRealCapitalUsd(solPriceUsd)
      : state.paperCapitalUsd;
    const dailyPnlPercent = ((currentCapitalUsd - state.dailyStartCapitalUsd) / state.dailyStartCapitalUsd) * 100;
    if (dailyPnlPercent <= -this.params.maxDailyLossPercent) {
      this.rejectWatch(mint, "limite de perte quotidienne atteinte — trading en pause pour aujourd'hui", score);
      return;
    }

    if (state.pausedUntil && new Date(state.pausedUntil).getTime() > Date.now()) {
      if (score < this.params.minScoreAfterPause) {
        this.rejectWatch(mint, `bot en pause après pertes consécutives (jusqu'à ${state.pausedUntil})`, score);
        return;
      }
      this.notify(`⚡ Score exceptionnel (${score}/100) pendant la pause — entrée exceptionnelle autorisée`);
    }

    const openPositions = getOpenPositions(this.telegramId);
    if (openPositions.length >= this.params.maxOpenPositions) {
      this.rejectWatch(mint, "nombre maximum de positions déjà atteint", score);
      return;
    }

    const positionSizeUsd = currentCapitalUsd * (this.params.positionPercent / 100);
    const entryPriceSol = marketCapUsd / solPriceUsd / PUMPFUN_TOTAL_SUPPLY;

    saveBotState(this.telegramId, state);

    try {
      let signature: string;
      if (this.params.liveTrading) {
        const positionSizeSol = positionSizeUsd / solPriceUsd;

        const balanceLamports = await this.connection.getBalance(this.signer.publicKey);
        const balanceSol = balanceLamports / 1_000_000_000;
        if (balanceSol - positionSizeSol - this.params.priorityFeeSol - 0.001 < this.params.reserveSolBalance) {
          this.rejectWatch(mint, "solde insuffisant pour garder la réserve de sécurité", score);
          return;
        }

        this.notify(`🎯 [LIVE] Score ${score}/100 sur ${mint.slice(0, 8)}... — achat de ${positionSizeSol.toFixed(4)} SOL`);
        signature = await executeTrade(this.connection, this.signer, {
          action: "buy",
          mint,
          amount: positionSizeSol,
          denominatedInSol: true,
          slippagePercent: this.params.maxSlippagePercent,
          priorityFeeSol: this.params.priorityFeeSol,
        });
      } else {
        simulateBuy(this.telegramId, mint, positionSizeUsd, marketCapUsd / PUMPFUN_TOTAL_SUPPLY);
        signature = `PAPER-${Date.now()}`;
        this.notify(`🎯 [PAPER] Score ${score}/100 sur ${mint.slice(0, 8)}... — achat simulé de $${positionSizeUsd.toFixed(2)}`);
      }

      const position: OpenPosition = {
        telegramId: this.telegramId,
        mint,
        entryPriceSol,
        lastKnownPriceSol: entryPriceSol,
        lastUpdatedAt: new Date().toISOString(),
        positionSizeSol: this.params.liveTrading ? positionSizeUsd / solPriceUsd : positionSizeUsd,
        remainingPercent: 100,
        takeProfitLevelsHit: [],
        openedAt: new Date().toISOString(),
      };
      saveOpenPosition(position);
      logTrade({
        telegramId: this.telegramId,
        action: "buy",
        mint,
        amountSol: position.positionSizeSol,
        signature,
        timestamp: new Date().toISOString(),
      });

      const watchObj = this.watches.get(mint);
      if (watchObj) watchObj.decided = true;
      const interval = this.evalIntervals.get(mint);
      if (interval) clearInterval(interval);
      this.evalIntervals.delete(mint);

      this.notify(
        `✅ Position ouverte sur ${mint.slice(0, 8)}...${
          this.params.liveTrading ? `\nhttps://solscan.io/tx/${signature}` : " (paper)"
        }`
      );
    } catch (err) {
      this.notify(`❌ Échec de l'entrée sur ${mint.slice(0, 8)}... : ${(err as Error).message}`);
    }
  }

  private async getRealCapitalUsd(solPriceUsd: number): Promise<number> {
    const balanceLamports = await this.connection.getBalance(this.signer.publicKey);
    return (balanceLamports / 1_000_000_000) * solPriceUsd;
  }

  private async updatePositionAndCheckExit(position: OpenPosition, tradeEvent: any): Promise<void> {
    if (!tradeEvent.marketCapSol || position.entryPriceSol <= 0) return;

    const currentPriceSol = tradeEvent.marketCapSol / PUMPFUN_TOTAL_SUPPLY;
    position.lastKnownPriceSol = currentPriceSol;
    position.lastUpdatedAt = new Date().toISOString();

    const gainPercent = ((currentPriceSol - position.entryPriceSol) / position.entryPriceSol) * 100;

    if (gainPercent <= this.params.stopLossPercent) {
      await this.exitPosition(position, 100, gainPercent, `🛑 Stop-loss déclenché (${gainPercent.toFixed(1)}%)`);
      return;
    }

    const levels = [
      { key: "TP1", gain: this.params.tp1Percent, sell: this.params.tp1SellPercent },
      { key: "TP2", gain: this.params.tp2Percent, sell: this.params.tp2SellPercent },
      { key: "TP3", gain: this.params.tp3Percent, sell: this.params.tp3SellPercent },
    ];

    for (const level of levels) {
      if (!position.takeProfitLevelsHit.includes(level.gain) && gainPercent >= level.gain) {
        position.takeProfitLevelsHit.push(level.gain);
        await this.exitPosition(position, level.sell, gainPercent, `🎉 ${level.key} +${level.gain}% atteint`);
      }
    }

    if (position.takeProfitLevelsHit.includes(this.params.tp3Percent) && position.remainingPercent > 0) {
      const peak = Math.max(this.peakPrices.get(position.mint) ?? currentPriceSol, currentPriceSol);
      this.peakPrices.set(position.mint, peak);
      const dropFromPeakPercent = ((peak - currentPriceSol) / peak) * 100;
      if (dropFromPeakPercent >= this.params.trailingStopPercent) {
        await this.exitPosition(
          position,
          100,
          gainPercent,
          `📉 Trailing stop déclenché (-${dropFromPeakPercent.toFixed(1)}% depuis le plus haut)`
        );
      }
    }

    saveOpenPosition(position);
  }

  private async exitPosition(
    position: OpenPosition,
    sellPercent: number,
    gainPercent: number,
    reason: string
  ): Promise<void> {
    try {
      this.notify(`${reason} sur ${position.mint.slice(0, 8)}...`);
      let signature: string;

      if (this.params.liveTrading) {
        signature = await executeTrade(this.connection, this.signer, {
          action: "sell",
          mint: position.mint,
          amount: `${sellPercent}%`,
          denominatedInSol: false,
          slippagePercent: this.params.maxSlippagePercent,
          priorityFeeSol: this.params.priorityFeeSol,
        });
      } else {
        const usdReceived = position.positionSizeSol * (sellPercent / 100) * (1 + gainPercent / 100);
        simulateSell(this.telegramId, position.mint, usdReceived);
        signature = `PAPER-${Date.now()}`;
      }

      logTrade({
        telegramId: this.telegramId,
        action: "sell",
        mint: position.mint,
        signature,
        timestamp: new Date().toISOString(),
      });

      const pnlUsdForSlice = position.positionSizeSol * (sellPercent / 100) * (gainPercent / 100);
      logClosedTrade({
        telegramId: this.telegramId,
        mint: position.mint,
        pnlUsd: pnlUsdForSlice,
        pnlPercent: gainPercent,
        wasPaper: !this.params.liveTrading,
        closedAt: new Date().toISOString(),
      });

      if (sellPercent === 100) {
        const state = getBotState(this.telegramId, this.params.startingCapitalUsd);
        if (gainPercent < 0) {
          state.consecutiveLosses += 1;
          if (state.consecutiveLosses >= this.params.consecutiveLossesForPause) {
            state.pausedUntil = new Date(Date.now() + this.params.pauseDurationMinutes * 60_000).toISOString();
            this.notify(`⏸️ ${state.consecutiveLosses} pertes consécutives — pause de ${this.params.pauseDurationMinutes} min`);
          }
        } else {
          state.consecutiveLosses = 0;
          state.pausedUntil = null;
        }
        saveBotState(this.telegramId, state);
      }

      position.remainingPercent -= sellPercent;
      if (position.remainingPercent <= 0) {
        closePosition(this.telegramId, position.mint);
        this.peakPrices.delete(position.mint);
        this.ws?.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [position.mint] }));
      } else {
        saveOpenPosition(position);
      }

      this.notify(
        `✅ Vente exécutée (${sellPercent}% de la position).${
          this.params.liveTrading ? `\nhttps://solscan.io/tx/${signature}` : " (paper)"
        }`
      );
    } catch (err) {
      this.notify(`❌ Échec de la vente sur ${position.mint.slice(0, 8)}... : ${(err as Error).message}`);
    }
  }
}