import { Connection, Keypair } from "@solana/web3.js";
import { executeTrade } from "./trade";
import { sellViaJupiter } from "./jupiter";

export interface SellResult {
  signature: string;
  usedFallback: boolean;
}

/**
 * Tente de vendre via PumpPortal (adapté à la bonding curve pump.fun) ;
 * si ça échoue — typiquement un token qui a migré vers un pool que PumpPortal
 * ne détecte plus bien — retente automatiquement via Jupiter, qui agrège
 * toutes les liquidités Solana (Raydium, PumpSwap, Orca...).
 */
export async function sellWithFallback(
  connection: Connection,
  signer: Keypair,
  mint: string,
  amount: string | number,
  slippagePercent: number,
  priorityFeeSol: number
): Promise<SellResult> {
  try {
    const signature = await executeTrade(connection, signer, {
      action: "sell",
      mint,
      amount,
      denominatedInSol: false,
      slippagePercent,
      priorityFeeSol,
    });
    return { signature, usedFallback: false };
  } catch (pumpPortalError) {
    try {
      const signature = await sellViaJupiter(connection, signer, mint, amount, slippagePercent, priorityFeeSol);
      return { signature, usedFallback: true };
    } catch (jupiterError) {
      throw new Error(
        `PumpPortal: ${(pumpPortalError as Error).message} | Jupiter (repli): ${(jupiterError as Error).message}`
      );
    }
  }
}
