export interface DexScreenerSnapshot {
  marketCapUsd: number;
  liquidityUsd: number;
  priceUsd: number;
  buys5m: number;
  sells5m: number;
}

/**
 * Interroge l'API publique DexScreener (gratuite, sans clé) pour un token donné.
 * Retourne null si le token n'a pas encore de paire indexée (rare pour pump.fun,
 * généralement disponible quelques secondes après la création).
 */
export async function fetchDexScreenerData(mint: string): Promise<DexScreenerSnapshot | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as { pairs?: any[] };
    if (!json.pairs || json.pairs.length === 0) return null;

    // S'il y a plusieurs paires (ex. bonding curve + migré), on prend celle avec le plus de liquidité
    const pair = json.pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best));

    return {
      marketCapUsd: pair.marketCap ?? pair.fdv ?? 0,
      liquidityUsd: pair.liquidity?.usd ?? 0,
      priceUsd: parseFloat(pair.priceUsd ?? "0"),
      buys5m: pair.txns?.m5?.buys ?? 0,
      sells5m: pair.txns?.m5?.sells ?? 0,
    };
  } catch {
    return null; // réseau lent, rate limit, ou token pas encore indexé — on réessaiera au prochain cycle
  }
}