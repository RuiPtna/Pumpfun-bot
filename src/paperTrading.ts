import { getBotState, saveBotState, logTrade, logRejectedToken } from "./db";

/**
 * Frais estimés d'un aller-retour de trade réel, qu'on simule ici pour que le paper trading
 * reflète honnêtement ce qui se passerait en argent réel — sans ça, le paper trading surestime
 * systématiquement la performance (aucun frais de réseau, de swap, ni de glissement), ce qui
 * est trompeur surtout sur de petites positions où les frais fixes pèsent proportionnellement
 * plus lourd. Deux composantes : un pourcentage (frais de swap DEX + glissement réaliste) et un
 * montant fixe (frais de priorité réseau, payé par transaction quel que soit sa taille).
 */
const SIMULATED_SWAP_FEE_PERCENT = 1; // frais DEX + glissement approximés, par transaction

/**
 * Simule un achat/vente sans jamais toucher au wallet réel.
 * Utilisé tant que LIVE_TRADING = false (comportement par défaut et recommandé
 * tant que la stratégie n'a pas été observée en paper trading).
 */
export function simulateBuy(
  telegramId: number,
  mint: string,
  usdAmount: number,
  entryPriceUsdPerToken: number,
  priorityFeeUsd: number
): { tokensBought: number } {
  const state = getBotState(telegramId);
  const swapFeeUsd = usdAmount * (SIMULATED_SWAP_FEE_PERCENT / 100);
  const totalCostUsd = usdAmount + swapFeeUsd + priorityFeeUsd;
  state.paperCapitalUsd -= totalCostUsd;
  saveBotState(telegramId, state);

  logTrade({
    telegramId,
    action: "buy",
    mint,
    amountSol: 0, // paper trade : pas de SOL réellement dépensé
    signature: `PAPER-${Date.now()}`,
    timestamp: new Date().toISOString(),
  });

  // Les frais réduisent le montant réellement investi dans le token, donc le nombre de tokens
  // obtenus pour ce prix — cohérent avec une exécution réelle dégradée par les frais.
  return { tokensBought: usdAmount / entryPriceUsdPerToken };
}

export function simulateSell(telegramId: number, mint: string, usdReceived: number, priorityFeeUsd: number): void {
  const state = getBotState(telegramId);
  const swapFeeUsd = usdReceived * (SIMULATED_SWAP_FEE_PERCENT / 100);
  const netUsdReceived = usdReceived - swapFeeUsd - priorityFeeUsd;
  state.paperCapitalUsd += netUsdReceived;
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
