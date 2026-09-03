import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_URL = "https://quote-api.jup.ag/v6/swap";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

interface JupiterQuote {
  [key: string]: unknown;
}

async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps: number
): Promise<JupiterQuote> {
  const url = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Jupiter quote a échoué (${res.status}): ${await res.text()}`);
  return res.json();
}

async function getSwapTransaction(quote: JupiterQuote, userPublicKey: string, priorityFeeSol: number): Promise<string> {
  const res = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: Math.round(priorityFeeSol * 1_000_000_000),
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Jupiter swap a échoué (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { swapTransaction: string };
  return data.swapTransaction;
}

/** Exécute un swap via Jupiter (achat ou vente), en signant et envoyant la transaction. */
export async function jupiterSwap(
  connection: Connection,
  signer: Keypair,
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippagePercent: number,
  priorityFeeSol: number
): Promise<string> {
  const quote = await getQuote(inputMint, outputMint, amountRaw, Math.round(slippagePercent * 100));
  const swapTransactionBase64 = await getSwapTransaction(quote, signer.publicKey.toBase58(), priorityFeeSol);

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransactionBase64, "base64"));
  tx.sign([signer]);

  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });

  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
    "confirmed"
  );

  return signature;
}

/** Récupère le solde brut (raw, non divisé par les décimales) d'un token pour un wallet donné. */
export async function getRawTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: string
): Promise<{ amountRaw: string; decimals: number } | null> {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  const info = accounts.value[0]?.account.data.parsed?.info?.tokenAmount;
  if (!info) return null;
  return { amountRaw: info.amount, decimals: info.decimals };
}

/**
 * Vend un token via Jupiter. `amountSpec` accepte soit un pourcentage ("100%"),
 * soit un montant de tokens exact (nombre).
 */
export async function sellViaJupiter(
  connection: Connection,
  signer: Keypair,
  mint: string,
  amountSpec: string | number,
  slippagePercent: number,
  priorityFeeSol: number
): Promise<string> {
  const balance = await getRawTokenBalance(connection, signer.publicKey, mint);
  if (!balance || balance.amountRaw === "0") {
    throw new Error("Aucun solde de ce token trouvé dans le wallet");
  }

  let amountRaw: string;
  if (typeof amountSpec === "string" && amountSpec.trim().endsWith("%")) {
    const percent = parseFloat(amountSpec) / 100;
    amountRaw = Math.floor(Number(balance.amountRaw) * percent).toString();
  } else {
    const tokens = typeof amountSpec === "number" ? amountSpec : parseFloat(amountSpec);
    amountRaw = Math.floor(tokens * 10 ** balance.decimals).toString();
  }

  return jupiterSwap(connection, signer, mint, SOL_MINT, amountRaw, slippagePercent, priorityFeeSol);
}

/**
 * Achète un token via Jupiter avec un montant de SOL donné — utilisé en repli quand
 * PumpPortal refuse l'achat (ex. bonding curve déjà gradué vers Raydium/PumpSwap).
 */
export async function buyViaJupiter(
  connection: Connection,
  signer: Keypair,
  mint: string,
  amountSol: number,
  slippagePercent: number,
  priorityFeeSol: number
): Promise<string> {
  const amountRawLamports = Math.round(amountSol * 1_000_000_000).toString();
  return jupiterSwap(connection, signer, SOL_MINT, mint, amountRawLamports, slippagePercent, priorityFeeSol);
}
