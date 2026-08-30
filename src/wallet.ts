import crypto from "crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { getWallet, saveWallet, UserWallet } from "./db";

const ALGO = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const hex = process.env.WALLET_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY manquante ou invalide dans .env (attendu: 32 octets en hexadécimal, 64 caractères)"
    );
  }
  return Buffer.from(hex, "hex");
}

function encrypt(plainText: string): { encrypted: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

function decrypt(encryptedHex: string, ivHex: string, authTagHex: string): string {
  const decipher = crypto.createDecipheriv(ALGO, getEncryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf-8");
}

/** Récupère le wallet existant de l'utilisateur, ou en crée un nouveau. */
export function getOrCreateWallet(telegramId: number): UserWallet {
  const existing = getWallet(telegramId);
  if (existing) return existing;

  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);
  const { encrypted, iv, authTag } = encrypt(privateKeyBase58);

  const wallet: UserWallet = {
    telegramId,
    publicKey: keypair.publicKey.toBase58(),
    encryptedPrivateKey: encrypted,
    iv,
    authTag,
    createdAt: new Date().toISOString(),
  };
  saveWallet(wallet);
  return wallet;
}

/** Reconstruit le Keypair Solana signable à partir du wallet chiffré. */
export function loadKeypair(wallet: UserWallet): Keypair {
  const privateKeyBase58 = decrypt(wallet.encryptedPrivateKey, wallet.iv, wallet.authTag);
  return Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
}

/**
 * Déchiffre et retourne la clé privée en base58 (format standard, importable
 * dans Phantom, Backpack, etc.). À utiliser avec précaution : quiconque possède
 * cette chaîne a un contrôle total sur le wallet.
 */
export function exportPrivateKeyBase58(wallet: UserWallet): string {
  return decrypt(wallet.encryptedPrivateKey, wallet.iv, wallet.authTag);
}
