import { Connection, PublicKey } from "@solana/web3.js";

export interface HolderConcentration {
  topHolderPercent: number; // % détenu par le plus gros holder (souvent le créateur ou un sniper)
  top10Percent: number; // % détenu cumulé par les 10 plus gros holders
}

/**
 * Utilise getTokenLargestAccounts + getTokenSupply — deux méthodes RPC Solana
 * standard et gratuites (aucun indexeur payant nécessaire). Retourne null si
 * la donnée n'est pas disponible (RPC lent, token trop récent, etc.) — dans
 * ce cas, mieux vaut ne pas bloquer un achat sur une absence de donnée que
 * de risquer de tout rejeter en permanence.
 */
export async function fetchHolderConcentration(
  connection: Connection,
  mint: string
): Promise<HolderConcentration | null> {
  try {
    const mintPubkey = new PublicKey(mint);
    const [supplyInfo, largestAccounts] = await Promise.all([
      connection.getTokenSupply(mintPubkey),
      connection.getTokenLargestAccounts(mintPubkey),
    ]);

    const totalSupply = supplyInfo.value.uiAmount;
    if (!totalSupply || totalSupply <= 0) return null;

    const accounts = largestAccounts.value;
    if (accounts.length === 0) return null;

    const topHolderPercent = ((accounts[0].uiAmount ?? 0) / totalSupply) * 100;
    const top10Sum = accounts.slice(0, 10).reduce((sum, acc) => sum + (acc.uiAmount ?? 0), 0);
    const top10Percent = (top10Sum / totalSupply) * 100;

    return { topHolderPercent, top10Percent };
  } catch {
    return null;
  }
}
