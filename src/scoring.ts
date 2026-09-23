import { StrategyParams } from "./config";

export interface TokenWatch {
  mint: string;
  name: string;
  symbol: string;
  bondingCurveKey: string | null;
  creatorAddress: string | null;
  creatorInitialBuySol: number;
  createdAt: number;
  /** "pumpfun" (détection native, bien établie) ou "other" (flux multi-plateformes, moins vérifié) */
  platform: "pumpfun" | "other";
  /** Nom du pool à utiliser pour l'achat/vente via PumpPortal (ex. "bonk" pour LetsBonk) */
  poolHint: string | null;
  mcHistory: { t: number; marketCapUsd: number }[];
  realSolHistory: { t: number; realSol: number }[];
  lastLiquidityUsd: number;
  lastBuys5m: number;
  lastSells5m: number;
  /** Image de profil présente (rempli dès la première lecture DexScreener) */
  hasImage: boolean | null;
  /** Au moins un lien social/site web renseigné */
  hasSocialPresence: boolean | null;
  /** Variation de prix sur les 5 dernières minutes (DexScreener) — détecte un "couteau qui tombe" */
  lastPriceChange5mPercent: number | null;
  /** Âge de la paire de trading en minutes — exclut les produits déjà établis */
  lastPairAgeMinutes: number | null;
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
  createdAt: number,
  platform: "pumpfun" | "other" = "pumpfun",
  poolHint: string | null = null
): TokenWatch {
  return {
    mint,
    name,
    symbol,
    bondingCurveKey,
    creatorAddress,
    creatorInitialBuySol,
    createdAt,
    platform,
    poolHint,
    mcHistory: [],
    realSolHistory: [],
    lastLiquidityUsd: 0,
    lastBuys5m: 0,
    hasImage: null,
    hasSocialPresence: null,
    lastPriceChange5mPercent: null,
    lastPairAgeMinutes: null,
    lastSells5m: 0,
    lastRealSolReserves: 0,
    lastBondingCurveProgressPercent: 0,
    qualityChecked: false,
    decided: false,
  };
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

  // "Couteau qui tombe" : un token peut avoir déjà pompé bien au-delà de la fourchette et être
  // en train de s'effondrer À TRAVERS elle — son market cap semble alors "dans les clous" à
  // l'instant T, alors qu'il est en pleine chute, pas en train d'émerger. On vérifie la
  // tendance récente (5 min), rechargée à chaque cycle, pas seulement une fois à l'entrée.
  if (
    hasTradeCounts &&
    watch.lastPriceChange5mPercent !== null &&
    watch.lastPriceChange5mPercent <= params.maxRecent5mDropPercent
  ) {
    return {
      ok: false,
      reason: `chute récente trop forte (${watch.lastPriceChange5mPercent.toFixed(0)}% sur 5 min — probablement un couteau qui tombe)`,
    };
  }

  // Filtre anti-token-mort et filtre de progression : uniquement pertinents PENDANT la phase
  // bonding curve. Une fois le token gradué (hasTradeCounts=true, données DexScreener), ces
  // deux valeurs retombent à leur défaut neutre (0 SOL / 100% de "progression") et ne doivent
  // plus être vérifiées — sinon un token gradué serait toujours rejeté à tort, quel que soit
  // son potentiel réel (la liquidité DexScreener sert alors de garde-fou à la place).
  if (!hasTradeCounts) {
    if (watch.lastRealSolReserves < params.minRealSolInvested) {
      return { ok: false, reason: "pas assez de SOL réellement investi (token probablement mort/sans acheteurs)" };
    }

    // La progression de bonding curve utilise une formule spécifique au protocole pump.fun —
    // pas applicable aux autres plateformes (mécaniques de bonding curve différentes). On se
    // contente du filtre "SOL réellement investi" ci-dessus pour celles-ci.
    if (watch.platform === "pumpfun" && watch.lastBondingCurveProgressPercent < params.minBondingCurveProgressPercent) {
      return {
        ok: false,
        reason: `progression de la bonding curve trop faible (${watch.lastBondingCurveProgressPercent.toFixed(0)}%, min ${params.minBondingCurveProgressPercent}%)`,
      };
    }
  }

  return { ok: true };
}
