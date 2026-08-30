/**
 * Configuration de la stratégie de trading automatique.
 *
 * ⚠️ Aucune combinaison de filtres ne rend le trading de meme coins "sûr".
 * Ces valeurs par défaut visent à limiter la casse, pas à garantir un profit.
 * Ajuste-les selon ta propre tolérance au risque.
 */
export interface StrategyConfig {
  /** Le bot achète-t-il automatiquement les nouveaux tokens qui passent les filtres ? */
  autoTradeEnabled: boolean;

  /** Montant en SOL investi par position */
  positionSizeSol: number;

  /** Nombre maximum de positions ouvertes en même temps */
  maxOpenPositions: number;

  /** Ne pas acheter avant que le token ait cet âge minimum (secondes) */
  minTokenAgeSeconds: number;

  /** Ne pas acheter après que le token ait dépassé cet âge (secondes) — évite d'acheter "trop tard" */
  maxTokenAgeSeconds: number;

  /** % de la supply détenue par le créateur au-delà duquel on n'achète pas */
  maxCreatorHoldingPercent: number;

  /** Nombre minimum d'acheteurs distincts avant d'entrer en position */
  minUniqueBuyers: number;

  /** Stop-loss : vend tout si le prix chute de ce % par rapport au prix d'entrée */
  stopLossPercent: number;

  /** Take-profit paliers : [ {à +X%, vend Y% de la position} ... ] */
  takeProfitLevels: { gainPercent: number; sellPercent: number }[];

  /** Slippage autorisé sur les ordres (%) */
  slippagePercent: number;

  /** Priority fee en SOL pour accélérer l'inclusion des transactions */
  priorityFeeSol: number;
}

export const defaultStrategy: StrategyConfig = {
  autoTradeEnabled: false,
  positionSizeSol: 0.02,
  maxOpenPositions: 3,
  minTokenAgeSeconds: 45,
  maxTokenAgeSeconds: 300,
  maxCreatorHoldingPercent: 15,
  minUniqueBuyers: 5,
  stopLossPercent: -30,
  takeProfitLevels: [
    { gainPercent: 100, sellPercent: 50 },
    { gainPercent: 300, sellPercent: 30 },
  ],
  slippagePercent: 15,
  priorityFeeSol: 0.0005,
};

export interface TokenSnapshot {
  mint: string;
  createdAt: number; // timestamp ms
  creatorHoldingPercent: number;
  uniqueBuyers: number;
}

/** Décide si un token candidat passe les filtres d'entrée. */
export function passesEntryFilters(
  token: TokenSnapshot,
  config: StrategyConfig,
  now: number = Date.now()
): boolean {
  const ageSeconds = (now - token.createdAt) / 1000;

  if (ageSeconds < config.minTokenAgeSeconds) return false;
  if (ageSeconds > config.maxTokenAgeSeconds) return false;
  if (token.creatorHoldingPercent > config.maxCreatorHoldingPercent) return false;
  if (token.uniqueBuyers < config.minUniqueBuyers) return false;

  return true;
}