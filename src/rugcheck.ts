const RUGCHECK_SUMMARY_URL = "https://api.rugcheck.xyz/v1/tokens";

export interface RugCheckSummary {
  /** Score de risque normalisé 0–100 : PLUS HAUT = PLUS RISQUÉ. */
  riskScore: number;
  /** Autorité de mint révoquée (le créateur ne peut plus émettre de tokens). */
  mintAuthorityRevoked: boolean;
  /** Autorité de freeze révoquée (le créateur ne peut plus geler tes tokens). */
  freezeAuthorityRevoked: boolean;
  /** % de la liquidité verrouillée — 0 % signifie que le créateur peut la retirer quand il veut. */
  lpLockedPercent: number;
  /** Token déjà identifié comme ayant rugpull. */
  rugged: boolean;
  /** Libellés des risques détectés (ex. "Mutable metadata", "Single holder ownership"). */
  risks: string[];
}

/**
 * Interroge RugCheck, le service de référence d'analyse de risque des tokens Solana — c'est
 * l'intégration qui revient dans quasiment tous les bots open source sérieux, et qu'on n'avait
 * pas. Son intérêt : il agrège en un seul appel des vérifications qu'on ne peut pas faire
 * nous-mêmes à moindre coût (liquidité verrouillée ou non, détection de comportements
 * d'initiés, métadonnées modifiables, clusters de wallets liés au créateur).
 *
 * Endpoint public, sans clé API ni authentification.
 *
 * Renvoie null si le service ne répond pas ou ne connaît pas encore le token — un token très
 * récent peut ne pas encore être indexé, ce qui n'est pas en soi un signal négatif. L'appelant
 * décide quoi faire d'une absence de réponse (et ne doit jamais bloquer un achat pour ça,
 * sinon une panne du service gèlerait tout le bot).
 */
export async function fetchRugCheckSummary(mint: string): Promise<RugCheckSummary | null> {
  try {
    const res = await fetch(`${RUGCHECK_SUMMARY_URL}/${mint}/report/summary`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      score_normalised?: number;
      score?: number;
      rugged?: boolean;
      mintAuthority?: string | null;
      freezeAuthority?: string | null;
      risks?: { name?: string; level?: string }[];
      markets?: { lp?: { lpLockedPct?: number } }[];
    };

    // score_normalised est sur 100 ; certains retours n'ont que le score brut (échelle libre).
    const riskScore = typeof json.score_normalised === "number" ? json.score_normalised : null;
    if (riskScore === null) return null;

    // Une autorité à null signifie qu'elle a été révoquée — c'est le cas sain.
    const mintAuthorityRevoked = !json.mintAuthority;
    const freezeAuthorityRevoked = !json.freezeAuthority;

    const lpLockedPercent = json.markets?.[0]?.lp?.lpLockedPct ?? 0;

    return {
      riskScore,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      lpLockedPercent,
      rugged: json.rugged === true,
      risks: (json.risks ?? []).map((r) => r.name ?? "").filter(Boolean),
    };
  } catch {
    return null;
  }
}
