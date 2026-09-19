export interface DexScreenerSnapshot {
  marketCapUsd: number;
  liquidityUsd: number;
  priceUsd: number;
  buys5m: number;
  sells5m: number;
  name: string | null;
  symbol: string | null;
  /** Image de profil présente sur le token (absence = signal de lancement bâclé/produit en masse) */
  hasImage: boolean;
  /** Au moins un lien social ou site web renseigné (Twitter, Telegram, site...) */
  hasSocialPresence: boolean;
  /** Variation de prix sur les 5 dernières minutes — détecte un token en train de s'effondrer
   * après un pic, même si son market cap reste dans la fourchette acceptable à l'instant T. */
  priceChange5mPercent: number | null;
  /** Âge de la paire en minutes — sert à exclure les produits déjà établis (actions tokenisées,
   * staking liquide...) qui peuvent se glisser dans le scan mais n'ont rien d'un memecoin frais. */
  pairAgeMinutes: number | null;
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

    // CRITIQUE : l'API renvoie toutes les paires où le token apparaît — y compris celles où il
    // est le token COTÉ (quote) et non le token principal (base). Dans ce cas, pair.marketCap,
    // pair.priceUsd et pair.baseToken décrivent L'AUTRE token, pas le nôtre.
    // Sans ce filtre, on lisait le market cap d'un token totalement différent (constaté :
    // entrées à $151k ou $40k sur des tokens dont le vrai sommet était $4k et $5k).
    // Le tri par liquidité aggravait encore le problème, puisque la paire de l'autre token
    // — plus gros — est justement la plus liquide.
    const ownPairs = json.pairs.filter(
      (p) => typeof p.baseToken?.address === "string" && p.baseToken.address.toLowerCase() === mint.toLowerCase()
    );
    if (ownPairs.length === 0) return null;

    // Parmi NOS paires uniquement, on prend la plus liquide (ex. bonding curve vs pool migré).
    const pair = ownPairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best));

    return {
      marketCapUsd: pair.marketCap ?? pair.fdv ?? 0,
      liquidityUsd: pair.liquidity?.usd ?? 0,
      priceUsd: parseFloat(pair.priceUsd ?? "0"),
      buys5m: pair.txns?.m5?.buys ?? 0,
      sells5m: pair.txns?.m5?.sells ?? 0,
      name: typeof pair.baseToken?.name === "string" ? pair.baseToken.name : null,
      symbol: typeof pair.baseToken?.symbol === "string" ? pair.baseToken.symbol : null,
      hasImage: typeof pair.info?.imageUrl === "string" && pair.info.imageUrl.length > 0,
      hasSocialPresence: (pair.info?.socials?.length ?? 0) > 0 || (pair.info?.websites?.length ?? 0) > 0,
      priceChange5mPercent: typeof pair.priceChange?.m5 === "number" ? pair.priceChange.m5 : null,
      pairAgeMinutes: typeof pair.pairCreatedAt === "number" ? (Date.now() - pair.pairCreatedAt) / 60000 : null,
    };
  } catch {
    return null; // réseau lent, rate limit, ou token pas encore indexé — on réessaiera au prochain cycle
  }
}
