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
 * Attend la confirmation d'une transaction en interrogeant directement son statut réel,
 * plutôt que de se fier à connection.confirmTransaction() dont la logique d'expiration se
 * base sur un blockhash différent de celui utilisé pour construire la transaction (obtenu
 * après coup) — ce qui peut déclencher un faux "expiré" alors que la transaction est bien
 * passée sur la blockchain. Avec de l'argent réel en jeu, mieux vaut vérifier la vérité
 * terrain que de risquer de perdre le suivi d'un trade qui a en fait réussi.
 */
async function waitForConfirmation(connection: Connection, signature: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (status.value?.err) {
      throw new Error(`Transaction échouée on-chain : ${JSON.stringify(status.value.err)}`);
    }
    if (status.value?.confirmationStatus === "confirmed" || status.value?.confirmationStatus === "finalized") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(
    "Timeout en attendant la confirmation — vérifie manuellement sur Solscan si la transaction est passée avant de retenter."
  );
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
  await waitForConfirmation(connection, signature);

  return signature;
}
