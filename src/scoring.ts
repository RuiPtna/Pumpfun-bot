import { StrategyParams } from "./config";

export interface TokenWatch {
  mint: string;
  createdAt: number;
  mcHistory: { t: number; marketCapUsd: number }[];
  lastLiquidityUsd: number;
  lastBuys5m: number;
  lastSells5m: number;
  decided: boolean;
}

export function createTokenWatch(mint: string, createdAt: number): TokenWatch {
  return {
    mint,
    createdAt,
    mcHistory: [],
    lastLiquidityUsd: 0,
    lastBuys5m: 0,
    lastSells5m: 0,
    decided: false,
  };
}

export interface ScoreBreakdown {
  total: number;
  momentum: number;
  volumeQuality: number;
  buyerSellerRatio: number;
  structure: number;
  reasons: string[];
}

/**
 * ⚠️ Limitation assumée : les catégories "Creator" (comportement historique
 * du créateur) et "wallet clustering" nécessitent une source de données
 * on-chain indexée (type Helius, Bitquery) non branchée ici.
 */
export function scoreToken(watch: TokenWatch, currentMarketCapUsd: number): ScoreBreakdown {
  const reasons: string[] = [];

  // --- Momentum (35 points) ---
  let momentum = 0;
  if (watch.mcHistory.length >= 2) {
    const first = watch.mcHistory[0].marketCapUsd;
    const growthPercent = ((currentMarketCapUsd - first) / first) * 100;

    if (growthPercent > 20 && growthPercent < 300) {
      momentum = 35;
      reasons.push(`Momentum sain (+${growthPercent.toFixed(0)}%)`);
    } else if (growthPercent >= 300) {
      momentum = 10;
      reasons.push(`Pump vertical déjà avancé (+${growthPercent.toFixed(0)}%) — entrée risquée`);
    } else if (growthPercent > 0) {
      momentum = 15;
      reasons.push(`Croissance faible (+${growthPercent.toFixed(0)}%)`);
    } else {
      reasons.push(`Market cap en baisse (${growthPercent.toFixed(0)}%)`);
    }
  } else {
    reasons.push("Pas assez d'historique pour juger le momentum");
  }

  // --- Qualité du volume/liquidité (30 points) ---
  let volumeQuality = 0;
  const totalTrades5m = watch.lastBuys5m + watch.lastSells5m;
  const liquidityRatio = currentMarketCapUsd > 0 ? watch.lastLiquidityUsd / currentMarketCapUsd : 0;

  if (totalTrades5m >= 10 && liquidityRatio > 0.1) {
    volumeQuality = 30;
    reasons.push(`Activité et liquidité saines (${totalTrades5m} trades/5min, liquidité ${(liquidityRatio * 100).toFixed(0)}% du mcap)`);
  } else if (totalTrades5m >= 5) {
    volumeQuality = 15;
    reasons.push(`Activité modérée (${totalTrades5m} trades/5min)`);
  } else {
    reasons.push(`Peu d'activité récente (${totalTrades5m} trades/5min)`);
  }

  // --- Ratio acheteurs/vendeurs (20 points) ---
  let buyerSellerRatio = 0;
  if (watch.lastSells5m === 0 && watch.lastBuys5m > 0) {
    buyerSellerRatio = 20;
    reasons.push("Que des achats sur les 5 dernières minutes");
  } else if (watch.lastBuys5m > 0) {
    const ratio = watch.lastBuys5m / (watch.lastSells5m || 1);
    if (ratio >= 2) {
      buyerSellerRatio = 20;
      reasons.push(`Ratio achats/ventes favorable (${ratio.toFixed(1)})`);
    } else if (ratio >= 1) {
      buyerSellerRatio = 10;
      reasons.push(`Ratio achats/ventes neutre (${ratio.toFixed(1)})`);
    } else {
      reasons.push(`Plus de ventes que d'achats (ratio ${ratio.toFixed(1)})`);
    }
  }

  // --- Structure du graphique (15 points) ---
  let structure = 0;
  if (watch.mcHistory.length >= 3) {
    const values = watch.mcHistory.map((h) => h.marketCapUsd);
    const peak = Math.max(...values);
    const drawdownFromPeak = ((peak - currentMarketCapUsd) / peak) * 100;
    if (drawdownFromPeak <= 25) {
      structure = 15;
      reasons.push(`Retracement raisonnable depuis le plus haut (-${drawdownFromPeak.toFixed(0)}%)`);
    } else {
      reasons.push(`Retracement important (-${drawdownFromPeak.toFixed(0)}%) — setup invalidé`);
    }
  } else {
    reasons.push("Pas assez de points pour analyser la structure");
  }

  const total = momentum + volumeQuality + buyerSellerRatio + structure;
  return { total, momentum, volumeQuality, buyerSellerRatio, structure, reasons };
}

export function passesHardFilters(
  watch: TokenWatch,
  currentMarketCapUsd: number,
  params: StrategyParams,
  now: number = Date.now()
): { ok: boolean; reason?: string } {
  const ageMinutes = (now - watch.createdAt) / 60000;

  if (ageMinutes < params.minAgeMinutes) return { ok: false, reason: "trop jeune" };
  if (ageMinutes > params.maxAgeMinutes) return { ok: false, reason: "trop vieux" };
  if (currentMarketCapUsd < params.minMarketCapUsd) return { ok: false, reason: "market cap trop faible" };
  if (currentMarketCapUsd > params.maxMarketCapUsd) return { ok: false, reason: "market cap trop élevé" };

  return { ok: true };
}