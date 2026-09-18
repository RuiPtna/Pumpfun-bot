import { Connection } from "@solana/web3.js";

/**
 * Frais de priorité calculés dynamiquement à partir de la congestion réseau réelle.
 *
 * Tous les guides d'architecture de bots Solana convergent sur ce point : un frais de priorité
 * codé en dur est une erreur structurelle. Trop bas pendant une congestion, la transaction ne
 * passe pas (et sur une sortie de stop-loss, ça coûte bien plus cher que le frais lui-même) ;
 * trop haut en période calme, on surpaie chaque trade pour rien.
 *
 * On interroge getRecentPrioritizationFees, qui renvoie les frais réellement payés par les
 * transactions ayant abouti dans les ~150 derniers blocs, et on se positionne à un percentile
 * élevé de cette distribution plutôt qu'à la moyenne — l'objectif est de passer, pas d'être
 * dans la moyenne de ceux qui essaient.
 */

const CACHE_DURATION_MS = 10_000; // la congestion évolue vite, mais pas à la milliseconde
let cachedMicroLamportsPerCu: number | null = null;
let cachedAt = 0;

/** Budget de calcul typique d'un swap Solana (mesuré sur des routes classiques). */
const ESTIMATED_COMPUTE_UNITS = 300_000;

/** Bornes de sécurité, en SOL — évite qu'une donnée aberrante ne vide le wallet ou ne bloque tout. */
const MIN_FEE_SOL = 0.00005;
const MAX_FEE_SOL = 0.01;

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[index];
}

/**
 * Renvoie le frais de priorité à utiliser, en SOL.
 *
 * @param urgency "normal" pour un achat (on peut rater une opportunité sans drame),
 *                "urgent" pour une sortie de stop-loss ou de trailing stop (rater la
 *                transaction coûte bien plus que le surcoût du frais).
 * @param fallbackSol valeur de repli si le réseau ne répond pas — la valeur configurée.
 */
export async function getDynamicPriorityFeeSol(
  connection: Connection,
  urgency: "normal" | "urgent",
  fallbackSol: number
): Promise<number> {
  const now = Date.now();

  if (cachedMicroLamportsPerCu === null || now - cachedAt > CACHE_DURATION_MS) {
    try {
      const recent = await connection.getRecentPrioritizationFees();
      const fees = recent
        .map((f) => f.prioritizationFee)
        .filter((f) => f > 0)
        .sort((a, b) => a - b);

      // Beaucoup de blocs renvoient 0 (aucune contention) — si absolument tous sont à zéro,
      // le réseau est calme et le minimum suffit largement.
      cachedMicroLamportsPerCu = fees.length > 0 ? percentile(fees, 75) : 0;
      cachedAt = now;
    } catch {
      // RPC indisponible : on garde la valeur configurée plutôt que de deviner.
      return fallbackSol;
    }
  }

  // Sur une sortie urgente, on paie franchement plus cher pour maximiser les chances de passer
  // du premier coup — c'est exactement le scénario où l'on a déjà constaté que des tentatives
  // ratées en cascade transforment un stop à -10% en perte à -25%.
  const multiplier = urgency === "urgent" ? 3 : 1.2;
  const microLamports = cachedMicroLamportsPerCu * multiplier;

  // micro-lamports par unité de calcul → SOL total
  const feeSol = (microLamports * ESTIMATED_COMPUTE_UNITS) / 1_000_000 / 1_000_000_000;

  // On ne descend jamais sous la valeur configurée par l'utilisateur : elle sert de plancher
  // volontaire, le calcul dynamique ne peut que la renforcer quand le réseau est chargé.
  return Math.min(MAX_FEE_SOL, Math.max(MIN_FEE_SOL, Math.max(fallbackSol, feeSol)));
}
