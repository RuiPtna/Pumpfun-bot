let cachedPrice: number | null = null;
let cachedAt = 0;
const CACHE_DURATION_MS = 60_000;
const FALLBACK_PRICE_USD = 150; // utilisé uniquement si l'appel réseau échoue

/**
 * Cours SOL/USD, mis en cache 60s. Utilisé uniquement pour convertir une
 * taille de position en USD vers un montant de SOL à envoyer sur pump.fun —
 * plus besoin pour le suivi de PnL, qui se base directement sur le market
 * cap en USD fourni par DexScreener.
 */
export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();
  if (cachedPrice && now - cachedAt < CACHE_DURATION_MS) return cachedPrice;

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {
      signal: AbortSignal.timeout(3000),
    });
    const json = (await res.json()) as { solana?: { usd?: number } };
    if (json.solana?.usd) {
      cachedPrice = json.solana.usd;
      cachedAt = now;
      return cachedPrice;
    }
  } catch {
    // on retombe sur le cache existant ou la valeur par défaut
  }

  return cachedPrice ?? FALLBACK_PRICE_USD;
}