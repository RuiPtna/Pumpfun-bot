import { StrategyParams } from "./config";

export interface TokenWatch {
  mint: string;
  name: string;
  symbol: string;
  bondingCurveKey: string | null;
  createdAt: number;
  mcHistory: { t: number; marketCapUsd: number }[];
  lastLiquidityUsd: number;
  lastBuys5m: number;
  lastSells5m: number;
  lastRealSolReserves: number;
  decided: boolean;
}

export function createTokenWatch(
  mint: string,
  name: string,
  symbol: string,
  bondingCurveKey: string | null,
  createdAt: number
): TokenWatch {
  return {
    mint,
    name,
    symbol,
    bondingCurveKey,
    createdAt,
    mcHistory: [],
    lastLiquidityUsd: 0,
    lastBuys5m: 0,
    lastSells5m: 0,
    lastRealSolReserves: 0,
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
export function scoreToken(watch: TokenWatch, currentMarketCapUsd: number, hasTradeCounts: boolean): ScoreBreakdown {
  const reasons: string[] = [];

  // --- Momentum ---
  let momentum = 0;
  const momentumMax = hasTradeCounts ? 35 : 55;
  if (watch.mcHistory.length >= 2) {
    const first = watch.mcHistory[0].marketCapUsd;
    const growthPercent = ((currentMarketCapUsd - first) / first) * 100;

    if (growthPercent > 20 && growthPercent < 300) {
      momentum = momentumMax;
      reasons.push(`Momentum sain (+${growthPercent.toFixed(0)}%)`);
    } else if (growthPercent >= 300) {
      momentum = Math.round(momentumMax * 0.3);
      reasons.push(`Pump vertical déjà avancé (+${growthPercent.toFixed(0)}%) — entrée risquée`);
    } else if (growthPercent > 0) {
      momentum = Math.round(momentumMax * 0.4);
      reasons.push(`Croissance faible (+${growthPercent.toFixed(0)}%)`);
    } else {
      reasons.push(`Market cap en baisse (${growthPercent.toFixed(0)}%)`);
    }
  } else {
    reasons.push("Pas assez d'historique pour juger le momentum");
  }

  // --- Qualité du volume/liquidité (seulement si on a des données de trades, post-migration) ---
  let volumeQuality = 0;
  if (hasTradeCounts) {
    const totalTrades5m = watch.lastBuys5m + watch.lastSells5m;
    const liquidityRatio = currentMarketCapUsd > 0 ? watch.lastLiquidityUsd / currentMarketCapUsd : 0;
    if (totalTrades5m >= 10 && liquidityRatio > 0.1) {
      volumeQuality = 30;
      reasons.push(`Activité et liquidité saines (${totalTrades5m} trades/5min)`);
    } else if (totalTrades5m >= 5) {
      volumeQuality = 15;
      reasons.push(`Activité modérée (${totalTrades5m} trades/5min)`);
    } else {
      reasons.push(`Peu d'activité récente (${totalTrades5m} trades/5min)`);
    }
  }

  // --- Ratio acheteurs/vendeurs (seulement si disponible) ---
  let buyerSellerRatio = 0;
  const buyerSellerMax = hasTradeCounts ? 20 : 0;
  if (hasTradeCounts) {
    if (watch.lastSells5m === 0 && watch.lastBuys5m > 0) {
      buyerSellerRatio = buyerSellerMax;
      reasons.push("Que des achats sur les 5 dernières minutes");
    } else if (watch.lastBuys5m > 0) {
      const ratio = watch.lastBuys5m / (watch.lastSells5m || 1);
      if (ratio >= 2) {
        buyerSellerRatio = buyerSellerMax;
        reasons.push(`Ratio achats/ventes favorable (${ratio.toFixed(1)})`);
      } else if (ratio >= 1) {
        buyerSellerRatio = Math.round(buyerSellerMax * 0.5);
        reasons.push(`Ratio achats/ventes neutre (${ratio.toFixed(1)})`);
      } else {
        reasons.push(`Plus de ventes que d'achats (ratio ${ratio.toFixed(1)})`);
      }
    }
  }

  // --- Structure du graphique ---
  let structure = 0;
  const structureMax = hasTradeCounts ? 15 : 45;
  if (watch.mcHistory.length >= 3) {
    const values = watch.mcHistory.map((h) => h.marketCapUsd);
    const peak = Math.max(...values);
    const drawdownFromPeak = ((peak - currentMarketCapUsd) / peak) * 100;
    if (drawdownFromPeak <= 25) {
      structure = structureMax;
      reasons.push(`Retracement raisonnable depuis le plus haut (-${drawdownFromPeak.toFixed(0)}%)`);
    } else {
      reasons.push(`Retracement important (-${drawdownFromPeak.toFixed(0)}%) — setup invalidé`);
    }
  } else {
    reasons.push("Pas assez de points pour analyser la structure");
  }

  if (!hasTradeCounts) {
    reasons.push("⚠️ Token encore sur la bonding curve : score basé uniquement sur momentum + structure (pas de données achats/ventes)");
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

  // Filtre anti-token-mort : le market cap "virtuel" existe même sans aucun acheteur réel.
  // On exige un minimum de SOL réellement investi par de vrais traders (uniquement vérifiable
  // pendant la phase bonding curve — après migration, la liquidité DexScreener sert de proxy).
  if (watch.bondingCurveKey && watch.lastRealSolReserves < params.minRealSolInvested) {
    return { ok: false, reason: "pas assez de SOL réellement investi (token probablement mort/sans acheteurs)" };
  }

  return { ok: true };
}
