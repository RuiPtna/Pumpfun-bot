const PUMPFUN_COIN_URL = "https://frontend-api-v3.pump.fun/coins";

export interface PumpFunCoinData {
  /** Market cap en USD — exactement le chiffre affiché sur pump.fun pour ce token. */
  marketCapUsd: number;
  /** true une fois le token migré vers PumpSwap. */
  complete: boolean;
  name: string | null;
  symbol: string | null;
  /** Adresse du créateur, utile pour les filtres de concentration. */
  creator: string | null;
  /** Réserves SOL réelles déposées par de vrais acheteurs. */
  realSolReserves: number;
}

/**
 * Interroge l'API pump.fun pour obtenir le market cap OFFICIEL d'un token.
 *
 * Pourquoi cette source en priorité absolue : c'est littéralement le chiffre affiché sur
 * pump.fun. Toute autre source (DexScreener, calcul on-chain) peut diverger — DexScreener
 * calcule sur une base différente et a produit des écarts d'un facteur 30 sur des tokens
 * pré-migration, le calcul on-chain est juste mais casse silencieusement si le layout change.
 *
 * Ici, aucune interprétation : on lit la valeur que pump.fun publie lui-même. Si elle ne
 * correspond pas à ce que tu vois sur le site, c'est un vrai bug, pas une divergence de méthode.
 *
 * Renvoie null si le token est inconnu ou si l'API ne répond pas — l'appelant retombe alors
 * sur la lecture on-chain de la bonding curve, qui reste une source fiable et indépendante.
 */
export async function fetchPumpFunCoin(mint: string): Promise<PumpFunCoinData | null> {
  try {
    const res = await fetch(`${PUMPFUN_COIN_URL}/${mint}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      usd_market_cap?: number;
      complete?: boolean;
      name?: string;
      symbol?: string;
      creator?: string;
      real_sol_reserves?: number;
    };

    if (typeof json.usd_market_cap !== "number" || json.usd_market_cap <= 0) return null;

    return {
      marketCapUsd: json.usd_market_cap,
      complete: json.complete === true,
      name: typeof json.name === "string" ? json.name : null,
      symbol: typeof json.symbol === "string" ? json.symbol : null,
      creator: typeof json.creator === "string" ? json.creator : null,
      realSolReserves: typeof json.real_sol_reserves === "number" ? json.real_sol_reserves / 1e9 : 0,
    };
  } catch {
    return null;
  }
}
