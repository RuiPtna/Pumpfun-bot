import fs from "fs";
import path from "path";

/**
 * Stockage minimal en JSON sur disque.
 * Suffisant pour un usage perso / petit groupe d'utilisateurs.
 * Pour de la production sérieuse (plusieurs utilisateurs, gros volumes),
 * migre vers SQLite ou Postgres.
 */

export interface UserWallet {
  telegramId: number;
  publicKey: string;
  /** Clé privée chiffrée (AES-256-GCM), jamais stockée en clair */
  encryptedPrivateKey: string;
  iv: string;
  authTag: string;
  createdAt: string;
}

export interface Trade {
  telegramId: number;
  action: "buy" | "sell";
  mint: string;
  amountSol?: number;
  signature: string;
  timestamp: string;
}

export interface OpenPosition {
  telegramId: number;
  mint: string;
  entryPriceSol: number;
  positionSizeSol: number;
  /** % de la position encore détenu (commence à 100, diminue avec les ventes par palier) */
  remainingPercent: number;
  /** Paliers de take-profit déjà déclenchés, pour ne pas les redéclencher */
  takeProfitLevelsHit: number[];
  openedAt: string;
}

interface DbSchema {
  wallets: UserWallet[];
  trades: Trade[];
  openPositions: OpenPosition[];
}

const DB_PATH = path.join(__dirname, "..", "data", "db.json");

function ensureDb(): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initial: DbSchema = { wallets: [], trades: [], openPositions: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
  }
}

function readDb(): DbSchema {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, "utf-8");
  const data = JSON.parse(raw) as DbSchema;
  if (!data.openPositions) data.openPositions = []; // migration douce d'anciennes bases
  return data;
}

function writeDb(data: DbSchema): void {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export function getWallet(telegramId: number): UserWallet | undefined {
  return readDb().wallets.find((w) => w.telegramId === telegramId);
}

export function saveWallet(wallet: UserWallet): void {
  const data = readDb();
  const idx = data.wallets.findIndex((w) => w.telegramId === wallet.telegramId);
  if (idx >= 0) data.wallets[idx] = wallet;
  else data.wallets.push(wallet);
  writeDb(data);
}

export function logTrade(trade: Trade): void {
  const data = readDb();
  data.trades.push(trade);
  writeDb(data);
}

export function getTrades(telegramId: number): Trade[] {
  return readDb().trades.filter((t) => t.telegramId === telegramId);
}

export function getOpenPositions(telegramId: number): OpenPosition[] {
  return readDb().openPositions.filter((p) => p.telegramId === telegramId);
}

export function saveOpenPosition(position: OpenPosition): void {
  const data = readDb();
  const idx = data.openPositions.findIndex(
    (p) => p.telegramId === position.telegramId && p.mint === position.mint
  );
  if (idx >= 0) data.openPositions[idx] = position;
  else data.openPositions.push(position);
  writeDb(data);
}

export function closePosition(telegramId: number, mint: string): void {
  const data = readDb();
  data.openPositions = data.openPositions.filter(
    (p) => !(p.telegramId === telegramId && p.mint === mint)
  );