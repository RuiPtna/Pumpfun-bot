import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

const TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local";

export interface TradeParams {
  action: "buy" | "sell";
  mint: string;
  /** Montant en SOL (achat) ou en tokens / pourcentage type "100%" (vente) */
  amount: number | string;
  denominatedInSol: boolean;
  slippagePercent?: number;
  priorityFeeSol?: number;
  pool?: "pump" | "raydium" | "pump-amm" | "launchlab" | "raydium-cpmm" | "bonk" | "auto";
}

/**
 * Construit la transaction via l'API "Local Transaction" de PumpPortal
 * (non-custodiale côté PumpPortal : ils ne voient jamais notre clé privée),
 * la signe localement avec le keypair du wallet custodial, puis l'envoie
 * au réseau Solana via notre propre RPC.
 */
export async function executeTrade(
  connection: Connection,
  signer: Keypair,
  params: TradeParams
): Promise<string> {
  const response = await fetch(TRADE_LOCAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: signer.publicKey.toBase58(),
      action: params.action,
      mint: params.mint,
      amount: params.amount,
      denominatedInSol: params.denominatedInSol ? "true" : "false",
      slippage: params.slippagePercent ?? 15,
      priorityFee: params.priorityFeeSol ?? 0.0005,
      pool: params.pool ?? "auto",
    }),
  });

  if (response.status !== 200) {
    const errorText = await response.text();
    throw new Error(`PumpPortal a refusé la requête (${response.status}): ${errorText}`);
  }

  const txData = await response.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
  tx.sign([signer]);

  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });

  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    "confirmed"
  );

  return signature;
}