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
  trailingStopPercent: number; // appliqué sur le runner après TP4 (si non entièrement vendu)

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
  positionPercent: 15,
  maxOpenPositions: 2,

  minAgeMinutes: 2,
  maxAgeMinutes: 180,
  minMarketCapUsd: 10000,
  maxMarketCapUsd: 50000,
  minRealSolInvested: 1,
  maxTopHolderPercent: 35,
  maxTop10HolderPercent: 70,

  minEntryScore: 70,

  stopLossPercent: -18,
  tp1Percent: 30,
  tp1SellPercent: 25,
  tp2Percent: 50,
  tp2SellPercent: 25,
  tp3Percent: 100,
  tp3SellPercent: 30,
  tp4Percent: 200,
  tp4SellPercent: 100, // vend tout le reste à +200%
  trailingStopPercent: 15,

  maxDailyLossPercent: 80,
  consecutiveLossesForPause: 3,
  pauseDurationMinutes: 30,
  minScoreAfterPause: 80,
  pauseFeatureEnabled: true,

  maxSlippagePercent: 15,
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
  "trailingStopPercent",
  "maxDailyLossPercent",
  "consecutiveLossesForPause",
  "pauseDurationMinutes",
  "minScoreAfterPause",
  "maxSlippagePercent",
  "priorityFeeSol",
  "reserveSolBalance",
];

export const booleanParamKeys: (keyof StrategyParams)[] = ["paperMode", "liveTrading", "pauseFeatureEnabled"];
