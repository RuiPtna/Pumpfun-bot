import { StrategyParams } from "./config";

/**
 * Historique accumulé pendant la fenêtre d'observation d'un token candidat.
 * Alimenté en temps réel par les événements de trade reçus via PumpPortal
 * pendant que le token est "watché" (entre sa création et la décision d'achat/rejet).
 */
export interface TokenWatch {
  mint: string;
  createdAt: number;
  mcHistory: { t: number; marketCapUsd: number }[];
  buyCount: number;
  sellCount: number;
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  decided: boolean;
}

export function createTokenWatch(mint: string, createdAt: number): TokenWatch {
  return {
    mint,
    createdAt,
    mcHistory: [],
    buyCount: 0,
    sellCount: 0,
    uniqueBuyers: new Set(),
    uniqueSellers: new Set(),
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
 * du créateur) et "Distribution/wallet clustering" du cahier des charges
 * d'origine nécessitent une source de données on-chain indexée (type Helius,
 * Bitquery) non branchée ici. Leur poids est donc redistribué sur les
 * catégories calculables ci-dessous plutôt que de simuler une fausse note.
 */
export function scoreToken(watch: TokenWatch, currentMarketCapUsd: number): ScoreBreakdown {
  const reasons: string[] = [];

  // --- Momentum (35 points) : croissance du market cap dans le temps ---
  let momentum = 0;
  if (watch.mcHistory.length >= 2) {
    const first = watch.mcHistory[0].marketCapUsd;
    const last = currentMarketCapUsd;
    const growthPercent = ((last - first) / first) * 100;

    if (growthPercent > 20 && growthPercent < 300) {
      momentum = 35; // croissance saine
      reasons.push(`Momentum sain (+${growthPercent.toFixed(0)}%)`);
    } else if (growthPercent >= 300) {
      momentum = 10; // pump vertical déjà bien avancé — risqué d'entrer maintenant
      reasons.push(`Pump vertical détecté (+${growthPercent.toFixed(0)}%) — entrée risquée`);
    } else if (growthPercent > 0) {
      momentum = 15;
      reasons.push(`Croissance faible (+${growthPercent.toFixed(0)}%)`);
    } else {
      reasons.push(`Market cap en baisse (${growthPercent.toFixed(0)}%)`);
    }
  } else {
    reasons.push("Pas assez d'historique de prix pour juger le momentum");
  }

  // --- Qualité du volume (30 points) : activité organique vs quelques wallets ---
  let volumeQuality = 0;
  const totalTraders = watch.uniqueBuyers.size + watch.uniqueSellers.size;
  const totalTrades = watch.buyCount + watch.sellCount;
  if (totalTraders >= 8 && totalTrades > 0) {
    const tradesPerTrader = totalTrades / totalTraders;
    if (tradesPerTrader < 3) {
      volumeQuality = 30; // activité répartie entre plusieurs wallets
      reasons.push(`Activité répartie (${totalTraders} traders uniques)`);
    } else {
      volumeQuality = 12;
      reasons.push(`Volume concentré sur peu de wallets malgré ${totalTraders} traders`);
    }
  } else {
    reasons.push(`Trop peu de traders uniques observés (${totalTraders})`);
  }

  // --- Ratio acheteurs/vendeurs (20 points) ---
  let buyerSellerRatio = 0;
  if (watch.sellCount === 0 && watch.buyCount > 0) {
    buyerSellerRatio = 20;
    reasons.push("Que des achats jusqu'ici");
  } else if (watch.buyCount > 0) {
    const ratio = watch.buyCount / (watch.sellCount || 1);
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

  // --- Structure du graphique (15 points) : accumulation/retracement plutôt qu'effondrement ---
  let structure = 0;
  if (watch.mcHistory.length >= 3) {
    const values = watch.mcHistory.map((h) => h.marketCapUsd);
    const peak = Math.max(...values);
    const drawdownFromPeak = ((peak - currentMarketCapUsd) / peak) * 100;
    if (drawdownFromPeak <= 25) {
      structure = 15;
      reasons.push(`Retracement raisonnable depuis le plus haut (-${drawdownFromPeak.toFixed(0)}%)`);
    } else {
      reasons.push(`Retracement important depuis le plus haut (-${drawdownFromPeak.toFixed(0)}%) — setup invalidé`);
    }
  } else {
    reasons.push("Pas assez de points pour analyser la structure");
  }

  const total = momentum + volumeQuality + buyerSellerRatio + structure;

  return { total, momentum, volumeQuality, buyerSellerRatio, structure, reasons };
}

/** Filtres stricts à passer avant même de calculer un score. */
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