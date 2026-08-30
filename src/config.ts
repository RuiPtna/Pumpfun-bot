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
  trailingStopPercent: number; // appliqué sur le runner après TP3

  // Protection du capital
  maxDailyLossPercent: number;
  consecutiveLossesForPause: number;
  pauseDurationMinutes: number;
  minScoreAfterPause: number;

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
  maxOpenPositions: 1,

  minAgeMinutes: 2,
  maxAgeMinutes: 30,
  minMarketCapUsd: 10000,
  maxMarketCapUsd: 100000,

  minEntryScore: 75,

  stopLossPercent: -18,
  tp1Percent: 30,
  tp1SellPercent: 25,
  tp2Percent: 50,
  tp2SellPercent: 25,
  tp3Percent: 100,
  tp3SellPercent: 30, // le reste (~20%) devient le "runner" au trailing stop
  trailingStopPercent: 15,

  maxDailyLossPercent: 20,
  consecutiveLossesForPause: 3,
  pauseDurationMinutes: 30,
  minScoreAfterPause: 80,

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
  "minEntryScore",
  "stopLossPercent",
  "tp1Percent",
  "tp1SellPercent",
  "tp2Percent",
  "tp2SellPercent",
  "tp3Percent",
  "tp3SellPercent",
  "trailingStopPercent",
  "maxDailyLossPercent",
  "consecutiveLossesForPause",
  "pauseDurationMinutes",
  "minScoreAfterPause",
  "maxSlippagePercent",
  "priorityFeeSol",
  "reserveSolBalance",
];

export const booleanParamKeys: (keyof StrategyParams)[] = ["paperMode", "liveTrading"];