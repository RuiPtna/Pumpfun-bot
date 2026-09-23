const PUMPFUN_TRADES_URL = "https://frontend-api-v3.pump.fun/trades/all";

export interface TradeFlow {
  /** Nombre d'achats sur la fenêtre analysée. */
  buys: number;
  /** Nombre de ventes sur la fenêtre analysée. */
  sells: number;
  /** Part des achats dans le total, en % (50 = équilibre parfait). */
  buyRatioPercent: number;
  /** SOL net entré dans le token : total acheté − total vendu. Négatif = sorties nettes. */
  netSolFlow: number;
  /** Nombre d'acheteurs distincts — distingue une vraie demande d'un seul gros acheteur. */
  uniqueBuyers: number;
}

/**
 * Analyse les transactions récentes d'un token directement depuis pump.fun.
 *
 * Pourquoi c'est le filtre qui manquait : jusqu'ici le bot achetait des tokens sans savoir si
 * quelqu'un était en train d'acheter ou de vendre. Or avec un TP à +30 % et un stop à -10 %,
 * un token au prix purement aléatoire touche le TP environ 27 % du temps — un taux de réussite
 * inférieur signifie qu'on achète des tokens qui descendent déjà.
 *
 * Trois signaux complémentaires en sortent :
 *   - le ratio acheteurs/vendeurs (la pression du moment)
 *   - le SOL net entrant (du volume réel, pas juste un nombre de transactions)
 *   - le nombre d'acheteurs DISTINCTS (un seul gros acheteur n'est pas une demande)
 *
 * Renvoie null si l'API ne répond pas — l'appelant décide alors, mais ne doit pas bloquer
 * l'achat sur un simple échec technique.
 */
export async function fetchTradeFlow(mint: string, windowMinutes = 5, limit = 100): Promise<TradeFlow | null> {
  try {
    const res = await fetch(`${PUMPFUN_TRADES_URL}/${mint}?limit=${limit}&offset=0&minimumSize=0`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      is_buy?: boolean;
      sol_amount?: number;
      timestamp?: number;
      user?: string;
    }[];
    if (!Array.isArray(json) || json.length === 0) return null;

    const cutoffSeconds = Date.now() / 1000 - windowMinutes * 60;
    const recent = json.filter((t) => typeof t.timestamp === "number" && t.timestamp >= cutoffSeconds);
    if (recent.length === 0) return null;

    let buys = 0;
    let sells = 0;
    let solIn = 0;
    let solOut = 0;
    const buyers = new Set<string>();

    for (const t of recent) {
      const sol = typeof t.sol_amount === "number" ? t.sol_amount / 1e9 : 0;
      if (t.is_buy) {
        buys += 1;
        solIn += sol;
        if (t.user) buyers.add(t.user);
      } else {
        sells += 1;
        solOut += sol;
      }
    }

    const total = buys + sells;
    if (total === 0) return null;

    return {
      buys,
      sells,
      buyRatioPercent: (buys / total) * 100,
      netSolFlow: solIn - solOut,
      uniqueBuyers: buyers.size,
    };
  } catch {
    return null;
  }
}
