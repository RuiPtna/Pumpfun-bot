import { Connection, Keypair } from "@solana/web3.js";
import { executeTrade } from "./trade";
import { buyViaJupiter } from "./jupiter";

export interface BuyResult {
  signature: string;
  usedFallback: boolean;
}

/**
 * Tente d'acheter via PumpPortal (adapté à la bonding curve pump.fun) ; si ça échoue —
 * typiquement un token déjà gradué dont la liquidité a migré vers Raydium/PumpSwap et que
 * PumpPortal ne détecte pas toujours correctement en mode "auto" — retente automatiquement
 * via Jupiter, qui agrège toutes les liquidités Solana. Miroir exact de sellWithFallback,
 * pour un comportement cohérent à l'achat comme à la vente.
 */
export async function buyWithFallback(
  connection: Connection,
  signer: Keypair,
  mint: string,
  amountSol: number,
  slippagePercent: number,
  priorityFeeSol: number
): Promise<BuyResult> {
  try {
    const signature = await executeTrade(connection, signer, {
      action: "buy",
      mint,
      amount: amountSol,
      denominatedInSol: true,
      slippagePercent,
      priorityFeeSol,
    });
    return { signature, usedFallback: false };
  } catch (pumpPortalError) {
    try {
      const signature = await buyViaJupiter(connection, signer, mint, amountSol, slippagePercent, priorityFeeSol);
      return { signature, usedFallback: true };
    } catch (jupiterError) {
      throw new Error(
        `PumpPortal: ${(pumpPortalError as Error).message} | Jupiter (repli): ${(jupiterError as Error).message}`
      );
    }
  }
}
