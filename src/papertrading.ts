import { getBotState, saveBotState, logTrade, logRejectedToken } from "./db";

/**
 * Simule un achat/vente sans jamais toucher au wallet réel.
 * Utilisé tant que LIVE_TRADING = false (comportement par défaut et recommandé
 * tant que la stratégie n'a pas été observée en paper trading).
 */
export function simulateBuy(
  telegramId: number,
  mint: string,
  usdAmount: number,
  entryPriceUsdPerToken: number
): { tokensBought: number } {
  const state = getBotState(telegramId);
  state.paperCapitalUsd -= usdAmount;
  saveBotState(telegramId, state);

  logTrade({
    telegramId,
    action: "buy",
    mint,
    amountSol: 0, // paper trade : pas de SOL réellement dépensé
    signature: `PAPER-${Date.now()}`,
    timestamp: new Date().toISOString(),
  });

  return { tokensBought: usdAmount / entryPriceUsdPerToken };
}

export function simulateSell(
  telegramId: number,
  mint: string,
  usdReceived: number
): void {
  const state = getBotState(telegramId);
  state.paperCapitalUsd += usdReceived;
  saveBotState(telegramId, state);

  logTrade({
    telegramId,
    action: "sell",
    mint,
    signature: `PAPER-${Date.now()}`,
    timestamp: new Date().toISOString(),
  });
}

export { logRejectedToken };