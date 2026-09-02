import WebSocket from "ws";
import { Connection, Keypair } from "@solana/web3.js";
import { executeTrade } from "./trade";
import { sellWithFallback } from "./sellWithFallback";
import { StrategyParams } from "./config";
import { TokenWatch, createTokenWatch, scoreToken, passesHardFilters } from "./scoring";
import { fetchDexScreenerData } from "./dexscreener";
import { fetchBondingCurveMarketCap } from "./bondingCurve";
import { getSolPriceUsd } from "./priceFeed";
import { fetchHolderConcentration, fetchCreatorHoldingPercent } from "./holderAnalysis";
import { checkMintAuthorities } from "./mintAuthority";
import { escapeHtml } from "./htmlEscape";
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
  isBlacklistedCreator,
  OpenPosition,
} from "./db";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data"; // gratuit : uniquement subscribeNewToken ici
const WATCH_POLL_INTERVAL_MS = 20_000;
const POSITION_POLL_INTERVAL_MS = 5_000; // réduit de 15s pour réagir plus vite sur les positions ouvertes

interface MarketCapReading {
  marketCapUsd: number;
  hasTradeCounts: boolean;
  realSolReserves: number;
  bondingCurveProgressPercent: number;
}

export class AutoTrader {
  private ws: WebSocket | null = null;
  private watches = new Map<string, TokenWatch>();
  private evalIntervals = new Map<string, NodeJS.Timeout>();
  private peakMarketCaps = new Map<string, number>();
  private positionPollInterval: NodeJS.Timeout | null = null;
  private notify: (msg: string) => void;

  // Verrous anti-chevauchement : un setInterval ne garantit PAS que le cycle précédent soit
  // terminé avant d'en lancer un nouveau. Si un cycle prend plus de temps que l'intervalle
  // (appel réseau lent), plusieurs exécutions concurrentes peuvent se chevaucher sur la même
  // position/le même token et déclencher des ventes en double, avec des calculs de capital
  // qui se corrompent en cascade. Ces verrous empêchent ce chevauchement.
  private evaluatingMints = new Set<string>();
  private isPollingPositions = false;

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
      const mode = this.params.liveTrading ? "🔴 LIVE (argent réel)" : "📝 PAPER (simulation)";
      this.notify(`🟢 Auto-trading démarré — mode ${mode} (bonding curve on-chain + DexScreener)`);
    });

    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
    this.ws.on("error", (err) => this.notify(`⚠️ Erreur WebSocket : ${err.message}`));
    this.ws.on("close", () => {
      this.notify("🔴 Connexion perdue, reconnexion dans 5s...");
      this.ws = null;
      setTimeout(() => this.start(), 5000);
    });

    this.positionPollInterval = setInterval(() => this.pollAllPositions(), POSITION_POLL_INTERVAL_MS);
  }

  stop(): void {
    this.evalIntervals.forEach((t) => clearInterval(t));
    this.evalIntervals.clear();
    if (this.positionPollInterval) clearInterval(this.positionPollInterval);
    this.positionPollInterval = null;
    this.ws?.close();
    this.ws = null;
    this.notify("⏹️ Auto-trading arrêté.");
  }

  private handleMessage(raw: string): void {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data.txType === "create" && data.mint) {
      this.beginWatching(
        data.mint,
        data.name ?? "?",
        data.symbol ?? "?",
        data.bondingCurveKey ?? null,
        data.traderPublicKey ?? null,
        typeof data.solAmount === "number" ? data.solAmount : 0
      );
    }
  }

  private beginWatching(
    mint: string,
    name: string,
    symbol: string,
    bondingCurveKey: string | null,
    creatorAddress: string | null,
    creatorInitialBuySol: number
  ): void {
    // Garde-fou n°1 : si ce token est déjà observé ou déjà détenu, on ignore ce nouvel
    // événement de création plutôt que de créer un doublon (ex. si PumpPortal renvoie
    // deux fois le même événement, ou après une reconnexion du WebSocket).
    if (this.watches.has(mint) || getOpenPositions(this.telegramId).some((p) => p.mint === mint)) {
      return;
    }

    const state = getBotState(this.telegramId, this.params.startingCapitalUsd);
    state.tokensScanned += 1;
    saveBotState(this.telegramId, state);

    const watch = createTokenWatch(mint, name, symbol, bondingCurveKey, creatorAddress, creatorInitialBuySol, Date.now());
    this.watches.set(mint, watch);

    const interval = setInterval(() => this.evaluateWatch(mint), WATCH_POLL_INTERVAL_MS);
    this.evalIntervals.set(mint, interval);
    setTimeout(() => this.evaluateWatch(mint), 3_000);

    // Plafonné à ~24 jours : au-delà, setTimeout de Node.js déborde et se déclenche immédiatement
    // au lieu d'attendre (limite technique des entiers 32 bits), ce qui casserait un "sans plafond".
    const expiryDelayMs = Math.min((this.params.maxAgeMinutes * 60 + 30) * 1000, 2_000_000_000);
    setTimeout(() => this.finalizeWatchIfExpired(mint), expiryDelayMs);
  }

  /** Lit le market cap : priorité au compte on-chain de la bonding curve, sinon DexScreener après migration. */
  private async readMarketCap(mint: string, bondingCurveKey: string | null): Promise<MarketCapReading | null> {
    const solPriceUsd = await getSolPriceUsd();

    if (bondingCurveKey) {
      const onChain = await fetchBondingCurveMarketCap(this.connection, bondingCurveKey, solPriceUsd);
      if (onChain && !onChain.complete) {
        return {
          marketCapUsd: onChain.marketCapUsd,
          hasTradeCounts: false,
          realSolReserves: onChain.realSolReserves,
          bondingCurveProgressPercent: onChain.bondingCurveProgressPercent,
        };
      }
      // Si complete=true (gradué) ou lecture on-chain indisponible, on tente DexScreener en repli
    }

    const dex = await fetchDexScreenerData(mint);
    if (dex && dex.marketCapUsd > 0) {
      return { marketCapUsd: dex.marketCapUsd, hasTradeCounts: true, realSolReserves: 0, bondingCurveProgressPercent: 100 };
    }

    return null;
  }

  private async evaluateWatch(mint: string): Promise<void> {
    const watch = this.watches.get(mint);
    if (!watch || watch.decided) return;
    if (this.evaluatingMints.has(mint)) return; // un cycle précédent est encore en cours pour ce token
    this.evaluatingMints.add(mint);

    try {
      await this.evaluateWatchInner(mint, watch);
    } finally {
      this.evaluatingMints.delete(mint);
    }
  }

  private async evaluateWatchInner(mint: string, watch: TokenWatch): Promise<void> {
    const reading = await this.readMarketCap(mint, watch.bondingCurveKey);
    if (!reading) return; // pas encore de donnée exploitable, on réessaiera au prochain cycle

    if (reading.hasTradeCounts) {
      const dex = await fetchDexScreenerData(mint);
      if (dex) {
        watch.lastLiquidityUsd = dex.liquidityUsd;
        watch.lastBuys5m = dex.buys5m;
        watch.lastSells5m = dex.sells5m;
      }
    }

    watch.mcHistory.push({ t: Date.now(), marketCapUsd: reading.marketCapUsd });
    if (watch.mcHistory.length > 30) watch.mcHistory.shift();
    watch.lastRealSolReserves = reading.realSolReserves;
    watch.lastBondingCurveProgressPercent = reading.bondingCurveProgressPercent;

    if (!reading.hasTradeCounts && reading.realSolReserves > 0) {
      watch.realSolHistory.push({ t: Date.now(), realSol: reading.realSolReserves });
      if (watch.realSolHistory.length > 30) watch.realSolHistory.shift();
    }

    const hardFilter = passesHardFilters(watch, reading.marketCapUsd, this.params, reading.hasTradeCounts);
    if (!hardFilter.ok) {
      if (hardFilter.reason === "trop jeune") return;
      this.rejectWatch(mint, hardFilter.reason!, 0);
      return;
    }

    // Filtres de qualité/anti-rug — appliqués tôt, à TOUT candidat qui a passé les filtres
    // de base, plutôt que seulement à ceux qui atteignent déjà un bon score. Vérifiés une
    // seule fois par token (watch.qualityChecked) car ce sont des faits qui ne changent pas
    // au fil des cycles d'évaluation (sauf la concentration du créateur, qui reste vérifiée
    // ici en une passe — un compromis raisonnable plutôt que de la revérifier toutes les 20s).
    if (!watch.qualityChecked) {
      if (watch.creatorAddress && isBlacklistedCreator(this.telegramId, watch.creatorAddress)) {
        this.rejectWatch(mint, "créateur récidiviste (perte importante déjà subie avec ce créateur)", 0);
        return;
      }

      if (watch.creatorInitialBuySol < this.params.minCreatorInitialBuySol) {
        this.rejectWatch(
          mint,
          `achat initial du créateur trop faible (${watch.creatorInitialBuySol.toFixed(2)} SOL, min ${this.params.minCreatorInitialBuySol} SOL)`,
          0
        );
        return;
      }

      if (this.params.requireRevokedAuthorities) {
        const authorities = await checkMintAuthorities(this.connection, mint);
        if (authorities && (!authorities.mintAuthorityRevoked || !authorities.freezeAuthorityRevoked)) {
          this.rejectWatch(mint, "autorité de mint ou de freeze non révoquée (risque honeypot)", 0);
          return;
        }
      }

      if (watch.creatorAddress) {
        const creatorHoldingPercent = await fetchCreatorHoldingPercent(this.connection, mint, watch.creatorAddress);
        if (creatorHoldingPercent !== null && creatorHoldingPercent > this.params.maxCreatorHoldingPercent) {
          this.rejectWatch(
            mint,
            `créateur détient encore ${creatorHoldingPercent.toFixed(0)}% (max ${this.params.maxCreatorHoldingPercent}%)`,
            0
          );
          return;
        }
      }

      watch.qualityChecked = true;
    }

    const score = scoreToken(watch, reading.marketCapUsd, reading.hasTradeCounts);
    if (score.total < this.params.minEntryScore) return;

    await this.tryEnter(
      mint,
      watch.name,
      watch.symbol,
      watch.bondingCurveKey,
      watch.creatorAddress,
      watch.creatorInitialBuySol,
      reading.marketCapUsd,
      score.total,
      reading.hasTradeCounts
    );
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

    const state = getBotState(this.telegramId, this.params.startingCapitalUsd);
    state.tokensRejected += 1;
    saveBotState(this.telegramId, state);
    logRejectedToken({ telegramId: this.telegramId, mint, reason, score, timestamp: new Date().toISOString() });

    this.watches.delete(mint);
  }

  private async tryEnter(
    mint: string,
    name: string,
    symbol: string,
    bondingCurveKey: string | null,
    creatorAddress: string | null,
    creatorInitialBuySol: number,
    marketCapUsd: number,
    score: number,
    hasTradeCounts: boolean
  ): Promise<void> {
    // Garde-fou n°2 (défense en profondeur) : ne jamais acheter un token pour lequel une
    // position est déjà ouverte — l'écraser effacerait sa progression réelle (paliers déjà
    // atteints, % restant), causant des TP qui semblent se "re-déclencher" à répétition.
    if (getOpenPositions(this.telegramId).some((p) => p.mint === mint)) {
      const watchObj = this.watches.get(mint);
      if (watchObj) watchObj.decided = true;
      const interval = this.evalIntervals.get(mint);
      if (interval) clearInterval(interval);
      this.evalIntervals.delete(mint);
      return;
    }

    const state = getBotState(this.telegramId, this.params.startingCapitalUsd);
    const solPriceUsd = await getSolPriceUsd();

    // Les vérifications créateur/autorités/concentration ont déjà été faites plus tôt
    // (dans evaluateWatch, avant même le calcul du score) — pas besoin de les refaire ici.

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

    if (this.params.pauseFeatureEnabled && state.pausedUntil && new Date(state.pausedUntil).getTime() > Date.now()) {
      // Le contournement exceptionnel n'est autorisé que pour des tokens ayant de vraies données
      // de trading (post-migration) — un score élevé calculé sur la seule bonding curve (2 critères
      // sur 4, sans preuve d'activité réelle) n'est pas une preuve suffisante pour lever une pause.
      if (score < this.params.minScoreAfterPause || !hasTradeCounts) {
        this.rejectWatch(mint, `bot en pause après pertes consécutives (jusqu'à ${state.pausedUntil})`, score);
        return;
      }
      this.notify(`⚡ Score exceptionnel (${score}/100, données réelles confirmées) pendant la pause — entrée exceptionnelle autorisée`);
    }

    const openPositions = getOpenPositions(this.telegramId);
    const isPerfectScore = score >= 100 && hasTradeCounts;
    if (openPositions.length >= this.params.maxOpenPositions && !isPerfectScore) {
      this.rejectWatch(mint, "nombre maximum de positions déjà atteint", score);
      return;
    }
    if (isPerfectScore && openPositions.length >= this.params.maxOpenPositions) {
      this.notify(`🌟 Score parfait (100/100, données réelles) sur ${symbol} — entrée au-delà de la limite de positions habituelle`);
    }

    // Vérification de la concentration des holders — uniquement pertinente APRÈS migration.
    // Tant que le token est sur la bonding curve, celle-ci détient elle-même la grande majorité
    // de la supply (c'est le mécanisme même de la curve, pas un signal de rug) : appliquer ce
    // filtre à ce stade rejetterait quasiment tous les tokens non gradués.
    if (hasTradeCounts) {
      const holderData = await fetchHolderConcentration(this.connection, mint);
      if (holderData) {
        if (holderData.topHolderPercent > this.params.maxTopHolderPercent) {
          this.rejectWatch(
            mint,
            `plus gros holder détient ${holderData.topHolderPercent.toFixed(0)}% (max ${this.params.maxTopHolderPercent}%)`,
            score
          );
          return;
        }
        if (holderData.top10Percent > this.params.maxTop10HolderPercent) {
          this.rejectWatch(
            mint,
            `top 10 holders détiennent ${holderData.top10Percent.toFixed(0)}% (max ${this.params.maxTop10HolderPercent}%)`,
            score
          );
          return;
        }
      }
    }

    const positionSizeUsd = currentCapitalUsd * (this.params.positionPercent / 100);
    saveBotState(this.telegramId, state);

    try {
      let signature: string;
      const positionSizeSol = positionSizeUsd / solPriceUsd;

      if (this.params.liveTrading) {
        const balanceLamports = await this.connection.getBalance(this.signer.publicKey);
        const balanceSol = balanceLamports / 1_000_000_000;
        if (balanceSol - positionSizeSol - this.params.priorityFeeSol - 0.001 < this.params.reserveSolBalance) {
          this.rejectWatch(mint, "solde insuffisant pour garder la réserve de sécurité", score);
          return;
        }

        signature = await executeTrade(this.connection, this.signer, {
          action: "buy",
          mint,
          amount: positionSizeSol,
          denominatedInSol: true,
          slippagePercent: this.params.maxSlippagePercent,
          priorityFeeSol: this.params.priorityFeeSol,
        });
      } else {
        simulateBuy(this.telegramId, mint, positionSizeUsd, marketCapUsd);
        signature = `PAPER-${Date.now()}`;
      }

      const position: OpenPosition = {
        telegramId: this.telegramId,
        mint,
        name,
        symbol,
        bondingCurveKey,
        creatorAddress,
        entryMarketCapUsd: marketCapUsd,
        lastKnownMarketCapUsd: marketCapUsd,
        lastUpdatedAt: new Date().toISOString(),
        positionSizeUsd,
        remainingPercent: 100,
        takeProfitLevelsHit: [],
        openedAt: new Date().toISOString(),
      };
      saveOpenPosition(position);

      logTrade({
        telegramId: this.telegramId,
        action: "buy",
        mint,
        amountSol: this.params.liveTrading ? positionSizeUsd / solPriceUsd : 0,
        signature,
        timestamp: new Date().toISOString(),
      });

      const watchObj = this.watches.get(mint);
      if (watchObj) watchObj.decided = true;
      const interval = this.evalIntervals.get(mint);
      if (interval) clearInterval(interval);
      this.evalIntervals.delete(mint);

      const modeTag = this.params.liveTrading ? "🔴 LIVE" : "📝 PAPER";
      const amountLine = this.params.liveTrading
        ? `${positionSizeSol.toFixed(4)} SOL`
        : `$${positionSizeUsd.toFixed(2)} (simulé)`;
      const txLine = this.params.liveTrading ? `\n<a href="https://solscan.io/tx/${signature}">Voir la transaction</a>` : "";
      this.notify(
        `✅ ${modeTag} — Position ouverte sur <b>${escapeHtml(symbol)}</b> (${escapeHtml(name)}) <code>${mint.slice(0, 6)}...</code>\n` +
          `Score <b>${score}/100</b> — ${amountLine} — entrée à <b>$${marketCapUsd.toFixed(0)}</b> de market cap${txLine}`
      );
    } catch (err) {
      this.notify(`❌ Échec de l'entrée sur ${escapeHtml(symbol)} (${escapeHtml(name)})... : ${escapeHtml((err as Error).message)}`);
    }
  }

  private async getRealCapitalUsd(solPriceUsd: number): Promise<number> {
    const balanceLamports = await this.connection.getBalance(this.signer.publicKey);
    return (balanceLamports / 1_000_000_000) * solPriceUsd;
  }

  private async pollAllPositions(): Promise<void> {
    if (this.isPollingPositions) return; // le cycle précédent tourne encore, on saute celui-ci
    this.isPollingPositions = true;
    try {
      const positions = getOpenPositions(this.telegramId);
      for (const position of positions) {
        const reading = await this.readMarketCap(position.mint, position.bondingCurveKey);
        if (!reading) continue;
        await this.updatePositionAndCheckExit(position, reading.marketCapUsd);
      }
    } finally {
      this.isPollingPositions = false;
    }
  }

  private async updatePositionAndCheckExit(position: OpenPosition, currentMarketCapUsd: number): Promise<void> {
    if (position.entryMarketCapUsd <= 0) return;

    // Auto-réparation : une position déjà à 0% ou moins (bug de dépassement corrigé ci-dessous)
    // ne doit plus être suivie ni provoquer de calculs de PnL faussés.
    if (position.remainingPercent <= 0) {
      closePosition(this.telegramId, position.mint);
      this.peakMarketCaps.delete(position.mint);
      return;
    }

    position.lastKnownMarketCapUsd = currentMarketCapUsd;
    position.lastUpdatedAt = new Date().toISOString();

    const gainPercent = ((currentMarketCapUsd - position.entryMarketCapUsd) / position.entryMarketCapUsd) * 100;

    if (gainPercent <= this.params.stopLossPercent) {
      await this.exitPosition(position, 100, gainPercent, `🛑 <b>Stop-loss</b> déclenché (${gainPercent.toFixed(1)}%)`);
      return;
    }

    // Position stagnante : n'a touché ni SL ni aucun TP après le délai max — on ferme pour
    // libérer le capital et la place dans maxOpenPositions plutôt que d'attendre indéfiniment.
    const ageMinutes = (Date.now() - new Date(position.openedAt).getTime()) / 60000;
    if (position.takeProfitLevelsHit.length === 0 && ageMinutes >= this.params.maxHoldMinutes) {
      await this.exitPosition(
        position,
        100,
        gainPercent,
        `⏱️ Position stagnante depuis ${Math.round(ageMinutes)} min (${gainPercent >= 0 ? "+" : ""}${gainPercent.toFixed(1)}%) — clôturée pour libérer le capital`
      );
      return;
    }

    const levels = [
      { key: "TP1", gain: this.params.tp1Percent, sell: this.params.tp1SellPercent },
      { key: "TP2", gain: this.params.tp2Percent, sell: this.params.tp2SellPercent },
      { key: "TP3", gain: this.params.tp3Percent, sell: this.params.tp3SellPercent },
      { key: "TP4", gain: this.params.tp4Percent, sell: this.params.tp4SellPercent },
      { key: "TP5", gain: this.params.tp5Percent, sell: this.params.tp5SellPercent },
    ];

    for (const level of levels) {
      if (position.remainingPercent <= 0) break; // position déjà entièrement vendue, ne rien tenter de plus

      if (!position.takeProfitLevelsHit.includes(level.gain) && gainPercent >= level.gain) {
        position.takeProfitLevelsHit.push(level.gain);
        // Ne jamais vendre plus que ce qu'il reste réellement — un prix très volatile peut
        // franchir plusieurs paliers d'un coup entre deux vérifications.
        const sellPercent = Math.min(level.sell, position.remainingPercent);
        await this.exitPosition(position, sellPercent, gainPercent, `🎉 <b>${level.key} +${level.gain}%</b> atteint`);
      }
    }

    if (position.takeProfitLevelsHit.includes(this.params.tp4Percent) && position.remainingPercent > 0) {
      const peak = Math.max(this.peakMarketCaps.get(position.mint) ?? currentMarketCapUsd, currentMarketCapUsd);
      this.peakMarketCaps.set(position.mint, peak);
      const dropFromPeakPercent = ((peak - currentMarketCapUsd) / peak) * 100;
      if (dropFromPeakPercent >= this.params.trailingStopPercent) {
        await this.exitPosition(
          position,
          100,
          gainPercent,
          `📉 <b>Trailing stop</b> déclenché (-${dropFromPeakPercent.toFixed(1)}% depuis le plus haut)`
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
      let signature: string;
      let fallbackNote = "";

      if (this.params.liveTrading) {
        const result = await sellWithFallback(
          this.connection,
          this.signer,
          position.mint,
          `${sellPercent}%`,
          this.params.maxSlippagePercent,
          this.params.priorityFeeSol
        );
        signature = result.signature;
        if (result.usedFallback) {
          fallbackNote = "\nℹ️ Vendu via Jupiter (PumpPortal n'a pas pu traiter ce token, probablement gradué)";
        }
      } else {
        const usdReceived = position.positionSizeUsd * (sellPercent / 100) * (1 + gainPercent / 100);
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

      const pnlUsdForSlice = position.positionSizeUsd * (sellPercent / 100) * (gainPercent / 100);
      logClosedTrade({
        telegramId: this.telegramId,
        mint: position.mint,
        name: position.name,
        symbol: position.symbol,
        creatorAddress: position.creatorAddress,
        pnlUsd: pnlUsdForSlice,
        pnlPercent: gainPercent,
        wasPaper: !this.params.liveTrading,
        closedAt: new Date().toISOString(),
      });

      if (sellPercent === 100) {
        const state = getBotState(this.telegramId, this.params.startingCapitalUsd);
        if (gainPercent < 0) {
          state.consecutiveLosses += 1;
          if (this.params.pauseFeatureEnabled && state.consecutiveLosses >= this.params.consecutiveLossesForPause) {
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
        this.peakMarketCaps.delete(position.mint);

        // Instantané du capital une fois la position entièrement liquidée (réalisé, pas d'estimation
        // sur une position encore ouverte) — sert à calculer un vrai drawdown, pas un rejeu approximatif.
        if (!this.params.liveTrading) {
          const stateForSnapshot = getBotState(this.telegramId, this.params.startingCapitalUsd);
          stateForSnapshot.capitalHistory.push({ t: new Date().toISOString(), capital: stateForSnapshot.paperCapitalUsd });
          if (stateForSnapshot.capitalHistory.length > 500) stateForSnapshot.capitalHistory.shift();
          saveBotState(this.telegramId, stateForSnapshot);
        }
      } else {
        saveOpenPosition(position);
      }

      const pnlSign = pnlUsdForSlice >= 0 ? "+" : "";
      const txLine = this.params.liveTrading ? `\n<a href="https://solscan.io/tx/${signature}">Voir la transaction</a>` : " (paper)";
      this.notify(
        `${reason} sur <b>${escapeHtml(position.symbol)}</b> (${escapeHtml(position.name)}) <code>${position.mint.slice(0, 6)}...</code>\n` +
          `Vendu ${sellPercent}% — <b>${gainPercent >= 0 ? "+" : ""}${gainPercent.toFixed(1)}%</b> (${pnlSign}$${pnlUsdForSlice.toFixed(2)})${txLine}${fallbackNote}`
      );
    } catch (err) {
      this.notify(`❌ Échec de la vente sur ${escapeHtml(position.symbol)} (${escapeHtml(position.name)})... : ${escapeHtml((err as Error).message)}`);
    }
  }
}

/**
 * Vend manuellement 100% d'une position (déclenché par le bouton "Vendre" sur /pnl),
 * en mettant à jour la base (clôture la position, log le trade) exactement comme
 * une sortie automatique — pour que le bot ne continue pas de suivre un solde vendu.
 */
export async function manualSellPosition(
  telegramId: number,
  mint: string,
  connection: Connection,
  signer: Keypair,
  params: StrategyParams
): Promise<string> {
  const position = getOpenPositions(telegramId).find((p) => p.mint === mint);
  if (!position) throw new Error("Position introuvable (déjà vendue ou fermée ?)");

  let signature: string;
  if (params.liveTrading) {
    const result = await sellWithFallback(connection, signer, mint, "100%", params.maxSlippagePercent, params.priorityFeeSol);
    signature = result.signature;
  } else {
    const gainPercent =
      position.entryMarketCapUsd > 0
        ? ((position.lastKnownMarketCapUsd - position.entryMarketCapUsd) / position.entryMarketCapUsd) * 100
        : 0;
    const usdReceived = position.positionSizeUsd * (position.remainingPercent / 100) * (1 + gainPercent / 100);
    simulateSell(telegramId, mint, usdReceived);
    signature = `PAPER-${Date.now()}`;
  }

  const gainPercent =
    position.entryMarketCapUsd > 0
      ? ((position.lastKnownMarketCapUsd - position.entryMarketCapUsd) / position.entryMarketCapUsd) * 100
      : 0;
  const pnlUsd = position.positionSizeUsd * (position.remainingPercent / 100) * (gainPercent / 100);

  logTrade({ telegramId, action: "sell", mint, signature, timestamp: new Date().toISOString() });
  logClosedTrade({
    telegramId,
    mint,
    name: position.name,
    symbol: position.symbol,
    creatorAddress: position.creatorAddress,
    pnlUsd,
    pnlPercent: gainPercent,
    wasPaper: !params.liveTrading,
    closedAt: new Date().toISOString(),
  });
  closePosition(telegramId, mint);

  if (!params.liveTrading) {
    const stateForSnapshot = getBotState(telegramId, params.startingCapitalUsd);
    stateForSnapshot.capitalHistory.push({ t: new Date().toISOString(), capital: stateForSnapshot.paperCapitalUsd });
    if (stateForSnapshot.capitalHistory.length > 500) stateForSnapshot.capitalHistory.shift();
    saveBotState(telegramId, stateForSnapshot);
  }

  return signature;
}
