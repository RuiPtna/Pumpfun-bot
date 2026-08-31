import { Connection, PublicKey } from "@solana/web3.js";

export interface HolderConcentration {
  topHolderPercent: number; // % détenu par le plus gros holder (souvent le créateur ou un sniper)
  top10Percent: number; // % détenu cumulé par les 10 plus gros holders
}

/**
 * Vérifie le % de la supply encore détenu par le créateur du token — l'un des
 * signaux de rug pull les plus fiables. Utilise getParsedTokenAccountsByOwner
 * (RPC standard, gratuit) sur l'adresse exacte du créateur, capturée à la
 * création du token — donc pas faussé par le compte de la bonding curve
 * elle-même, contrairement à un simple "plus gros holder du mint".
 */
export async function fetchCreatorHoldingPercent(
  connection: Connection,
  mint: string,
  creatorAddress: string
): Promise<number | null> {
  try {
    const [supplyInfo, creatorAccounts] = await Promise.all([
      connection.getTokenSupply(new PublicKey(mint)),
      connection.getParsedTokenAccountsByOwner(new PublicKey(creatorAddress), { mint: new PublicKey(mint) }),
    ]);

    const totalSupply = supplyInfo.value.uiAmount;
    if (!totalSupply || totalSupply <= 0) return null;

    const creatorBalance = creatorAccounts.value.reduce(
      (sum, acc) => sum + (acc.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0),
      0
    );

    return (creatorBalance / totalSupply) * 100;
  } catch {
    return null;
  }
}

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
