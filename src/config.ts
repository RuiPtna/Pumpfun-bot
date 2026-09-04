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

  minAgeMinutes: 4,
  maxAgeMinutes: 525600, // pas de plafond réel (1 an) — seul le minimum de 4 min compte désormais
  minMarketCapUsd: 35000,
  maxMarketCapUsd: 500000, // au-delà, trop tard dans le cycle du token, peu de potentiel de hausse restant
  minRealSolInvested: 1,
  maxCreatorHoldingPercent: 20,
  minCreatorInitialBuySol: 0.2,
  minBondingCurveProgressPercent: 10,
  requireRevokedAuthorities: true,
  maxTopHolderPercent: 40,
  maxTop10HolderPercent: 75,

  minEntryScore: 60,

  stopLossPercent: -15,
  tp1Percent: 30,
  tp1SellPercent: 50, // sécurise la moitié de la position dès un gain solide — le vrai levier
  tp2Percent: 60,
  tp2SellPercent: 25,
  tp3Percent: 120,
  tp3SellPercent: 15,
  tp4Percent: 250,
  tp4SellPercent: 7, // ne vend plus tout — laisse un petit "moon bag" courir vers TP5
  tp5Percent: 500,
  tp5SellPercent: 100, // vend le reste (≈3%) au dernier palier, sauf si le trailing stop se déclenche avant
  trailingStopPercent: 15,
  maxHoldMinutes: 45,

  maxDailyLossPercent: 80,
  consecutiveLossesForPause: 3,
  pauseDurationMinutes: 30,
  minScoreAfterPause: 80,
  pauseFeatureEnabled: false,

  maxSlippagePercent: 6,
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
  "priorityFeeSol",
  "reserveSolBalance",
];

export const booleanParamKeys: (keyof StrategyParams)[] = [
  "paperMode",
  "liveTrading",
  "pauseFeatureEnabled",
  "requireRevokedAuthorities",
];
