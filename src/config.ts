/**
 * Configuration centralisée — tous les paramètres modifiables du bot.
 * Rien ne doit être codé en dur ailleurs : tout passe par cet objet,
 * modifiable en direct via /set sur Telegram.
 */
export interface StrategyParams {
  // Capital & position
  startingCapitalUsd: number;
  positionPercent: number; // % du capital disponible engagé par trade
  maxOpenPositions: number;

  // Filtre initial
  minAgeMinutes: number;
  maxAgeMinutes: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;

  /** SOL réellement investi minimum dans la bonding curve avant d'acheter (filtre les tokens morts) */
  minRealSolInvested: number;

  /** % max de la supply que le créateur peut encore détenir avant d'acheter (signal de rug le plus fiable) */
  maxCreatorHoldingPercent: number;
  /** SOL minimum que le créateur doit avoir investi lui-même à la création (un achat initial trop faible corrèle avec les rugs instantanés) */
  minCreatorInitialBuySol: number;
  /** % minimum de progression de la bonding curve avant d'acheter — un token déjà avancé a survécu à la fenêtre la plus risquée */
  minBondingCurveProgressPercent: number;
  /** Rejette les tokens dont l'autorité de mint ou de freeze n'est pas révoquée (protection anti-honeypot) */
  requireRevokedAuthorities: boolean;
  /** Rejette les tokens sans image ET sans aucun lien social/site web (signal de lancement bâclé) */
  requireTokenMetadata: boolean;
  /** Rejette un token dont le prix a chuté de plus que ce seuil sur les 5 dernières minutes —
   * détecte un "couteau qui tombe" (pic suivi d'un effondrement), même si son market cap reste
   * dans la fourchette acceptable à l'instant T. Valeur négative, ex. -15. */
  maxRecent5mDropPercent: number;
  /** Active la détection sur d'autres plateformes (LetsBonk, etc.) via un flux tiers moins établi que PumpPortal — désactivé par défaut, à activer volontairement après tests en paper */
  enableMultiPlatform: boolean;
  /** % max détenu par le plus gros holder avant d'acheter (rejette si dépassé) */
  maxTopHolderPercent: number;
  /** % max détenu cumulé par les 10 plus gros holders avant d'acheter */
  maxTop10HolderPercent: number;

  // Scoring
  minEntryScore: number; // sur 100

  // Sortie
  stopLossPercent: number; // ex. -18
  tp1Percent: number; // ex. 30
  tp1SellPercent: number; // % de la position vendue à TP1
  tp2Percent: number;
  tp2SellPercent: number;
  tp3Percent: number;
  tp3SellPercent: number;
  tp4Percent: number;
  tp4SellPercent: number;
  tp5Percent: number; // dernier palier explicite avant le "moon bag" protégé par le trailing stop
  tp5SellPercent: number;
  trailingStopPercent: number; // appliqué sur le runner après TP4 (si non entièrement vendu)

  /** Durée max (minutes) qu'une position peut rester ouverte sans avoir touché SL ni aucun TP — au-delà, fermeture forcée pour libérer le capital */
  maxHoldMinutes: number;

  // Protection du capital
  maxDailyLossPercent: number;
  consecutiveLossesForPause: number;
  pauseDurationMinutes: number;
  minScoreAfterPause: number;
  /** Interrupteur général : si false, aucune pause automatique n'est déclenchée, quel que soit le nombre de pertes */
  pauseFeatureEnabled: boolean;

  // Exécution
  maxSlippagePercent: number;
  priorityFeeSol: number;
  reserveSolBalance: number;

  // Modes (sécurité)
  paperMode: boolean; // simulation, aucun vrai trade — vrai par défaut
  liveTrading: boolean; // doit être explicitement activé pour trader en réel
}

export const defaultParams: StrategyParams = {
  startingCapitalUsd: 20,
  positionPercent: 25,
  maxOpenPositions: 2,

  minAgeMinutes: 12, // laisse passer le "dump de graduation" (ventes massives des premiers holders juste après migration) avant d'évaluer
  maxAgeMinutes: 525600, // pas de plafond réel (1 an) — seul le minimum de 12 min compte désormais
  minMarketCapUsd: 20000, // abaissé pour reprendre aussi les tokens pré-migration (ex. ~25k) en plus des tokens gradués
  maxMarketCapUsd: 8000000, // relevé encore : les tokens déjà bien établis ont prouvé leur résistance, moins de rugs à ce stade
  minRealSolInvested: 1,
  maxCreatorHoldingPercent: 20,
  minCreatorInitialBuySol: 0.2,
  minBondingCurveProgressPercent: 10,
  requireRevokedAuthorities: true,
  requireTokenMetadata: true,
  maxRecent5mDropPercent: -15,
  enableMultiPlatform: false,
  maxTopHolderPercent: 40,
  maxTop10HolderPercent: 75,

  minEntryScore: 45,

  stopLossPercent: -10,
  tp1Percent: 30,
  tp1SellPercent: 100, // sortie unique et complète à +40% — plus simple, rien ne reste à gérer ensuite
  tp2Percent: 60,
  tp2SellPercent: 0, // palier désactivé — rien ne reste après TP1
  tp3Percent: 120,
  tp3SellPercent: 0,
  tp4Percent: 250,
  tp4SellPercent: 0,
  tp5Percent: 500,
  tp5SellPercent: 0,
  trailingStopPercent: 15,
  maxHoldMinutes: 45,

  maxDailyLossPercent: 80,
  consecutiveLossesForPause: 3,
  pauseDurationMinutes: 30,
  minScoreAfterPause: 80,
  pauseFeatureEnabled: false,

  maxSlippagePercent: 25,
  priorityFeeSol: 0.0005,
  reserveSolBalance: 0.05,

  paperMode: true,
  liveTrading: false,
};

/** Clés modifiables via /set, avec leur type pour la validation. */
export const numericParamKeys: (keyof StrategyParams)[] = [
  "startingCapitalUsd",
  "positionPercent",
  "maxOpenPositions",
  "minAgeMinutes",
  "maxAgeMinutes",
  "minMarketCapUsd",
  "maxMarketCapUsd",
  "minRealSolInvested",
  "maxCreatorHoldingPercent",
  "minCreatorInitialBuySol",
  "minBondingCurveProgressPercent",
  "maxTopHolderPercent",
  "maxTop10HolderPercent",
  "minEntryScore",
  "stopLossPercent",
  "tp1Percent",
  "tp1SellPercent",
  "tp2Percent",
  "tp2SellPercent",
  "tp3Percent",
  "tp3SellPercent",
  "tp4Percent",
  "tp4SellPercent",
  "tp5Percent",
  "tp5SellPercent",
  "trailingStopPercent",
  "maxHoldMinutes",
  "maxDailyLossPercent",
  "consecutiveLossesForPause",
  "pauseDurationMinutes",
  "minScoreAfterPause",
  "maxSlippagePercent",
  "maxRecent5mDropPercent",
  "priorityFeeSol",
  "reserveSolBalance",
];

export const booleanParamKeys: (keyof StrategyParams)[] = [
  "paperMode",
  "liveTrading",
  "pauseFeatureEnabled",
  "requireRevokedAuthorities",
  "requireTokenMetadata",
  "enableMultiPlatform",
];
