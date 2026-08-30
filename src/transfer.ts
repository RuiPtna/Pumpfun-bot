import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

/** Envoie un montant de SOL depuis le wallet du bot vers une adresse externe. */
export async function sendSol(
  connection: Connection,
  signer: Keypair,
  toAddress: string,
  amountSol: number
): Promise<string> {
  const toPubkey = new PublicKey(toAddress); // lève une erreur claire si l'adresse est invalide

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey,
      lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
    })
  );

  const signature = await connection.sendTransaction(transaction, [signer]);

  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
    "confirmed"
  );

  return signature;
}
