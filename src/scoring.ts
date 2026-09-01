import { StrategyParams } from "./config";

export interface TokenWatch {
  mint: string;
  name: string;
  symbol: string;
  bondingCurveKey: string | null;
  creatorAddress: string | null;
  creatorInitialBuySol: number;
  createdAt: number;
  mcHistory: { t: number; marketCapUsd: number }[];
  realSolHistory: { t: number; realSol: number }[];
  lastLiquidityUsd: number;
  lastBuys5m: number;
  lastSells5m: number;
  lastRealSolReserves: number;
  lastBondingCurveProgressPercent: number;
  qualityChecked: boolean;
  decided: boolean;
}

export function createTokenWatch(
  mint: string,
  name: string,
  symbol: string,
  bondingCurveKey: string | null,
  creatorAddress: string | null,
  creatorInitialBuySol: number,
  createdAt: number
): TokenWatch {
  return {
    mint,
    name,
    symbol,
    bondingCurveKey,
    creatorAddress,
    creatorInitialBuySol,
    createdAt,
    mcHistory: [],
    realSolHistory: [],
    lastLiquidityUsd: 0,
    lastBuys5m: 0,
    lastSells5m: 0,
    lastRealSolReserves: 0,
    lastBondingCurveProgressPercent: 0,
    qualityChecked: false,
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
  // Post-migration : le prix DexScreener reflète du vrai trading AMM, fiable tel quel.
  // Pré-migration : le prix seul peut être trompeur (quelques transactions suffisent à le
  // faire bouger sur la bonding curve). On utilise plutôt la croissance du SOL RÉELLEMENT
  // investi (realSolReserves) — cette valeur n'augmente que si de vrais acheteurs déposent
  // de l'argent, et diminue si des vendeurs retirent — donc un bien meilleur indicateur de
  // pression d'achat organique qu'une simple variation de prix.
  let momentum = 0;
  const momentumMax = hasTradeCounts ? 35 : 55;

  if (hasTradeCounts) {
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
  } else {
    if (watch.realSolHistory.length >= 2) {
      const first = watch.realSolHistory[0].realSol;
      const last = watch.realSolHistory[watch.realSolHistory.length - 1].realSol;

      if (first > 0) {
        const growthPercent = ((last - first) / first) * 100;

        if (growthPercent > 15 && growthPercent < 400) {
          momentum = momentumMax;
          reasons.push(`SOL réellement investi en hausse saine (+${growthPercent.toFixed(0)}%)`);
        } else if (growthPercent >= 400) {
          momentum = Math.round(momentumMax * 0.3);
          reasons.push(`Afflux de SOL très rapide (+${growthPercent.toFixed(0)}%) — possible pump artificiel`);
        } else if (growthPercent > 0) {
          momentum = Math.round(momentumMax * 0.4);
          reasons.push(`SOL investi en légère hausse (+${growthPercent.toFixed(0)}%)`);
        } else {
          reasons.push(`SOL investi stagnant ou en baisse (${growthPercent.toFixed(0)}%) — plus de ventes que d'achats`);
        }
      } else {
        reasons.push("Pas assez de SOL investi au départ pour calculer une tendance");
      }
    } else {
      reasons.push("Pas assez d'historique pour juger la pression d'achat réelle");
    }
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
  hasTradeCounts: boolean,
  now: number = Date.now()
): { ok: boolean; reason?: string } {
  const ageMinutes = (now - watch.createdAt) / 60000;

  if (ageMinutes < params.minAgeMinutes) return { ok: false, reason: "trop jeune" };
  if (ageMinutes > params.maxAgeMinutes) return { ok: false, reason: "trop vieux" };
  if (currentMarketCapUsd < params.minMarketCapUsd) return { ok: false, reason: "market cap trop faible" };
  if (currentMarketCapUsd > params.maxMarketCapUsd) return { ok: false, reason: "market cap trop élevé" };

  // Filtre anti-token-mort et filtre de progression : uniquement pertinents PENDANT la phase
  // bonding curve. Une fois le token gradué (hasTradeCounts=true, données DexScreener), ces
  // deux valeurs retombent à leur défaut neutre (0 SOL / 100% de "progression") et ne doivent
  // plus être vérifiées — sinon un token gradué serait toujours rejeté à tort, quel que soit
  // son potentiel réel (la liquidité DexScreener sert alors de garde-fou à la place).
  if (!hasTradeCounts) {
    if (watch.lastRealSolReserves < params.minRealSolInvested) {
      return { ok: false, reason: "pas assez de SOL réellement investi (token probablement mort/sans acheteurs)" };
    }

    if (watch.lastBondingCurveProgressPercent < params.minBondingCurveProgressPercent) {
      return {
        ok: false,
        reason: `progression de la bonding curve trop faible (${watch.lastBondingCurveProgressPercent.toFixed(0)}%, min ${params.minBondingCurveProgressPercent}%)`,
      };
    }
  }

  return { ok: true };
}
