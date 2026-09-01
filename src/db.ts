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
  name: string;
  symbol: string;
  bondingCurveKey: string | null;
  creatorAddress: string | null;
  entryMarketCapUsd: number;
  /** Dernier market cap connu (mis à jour à chaque poll DexScreener), pour afficher le PnL */
  lastKnownMarketCapUsd: number;
  lastUpdatedAt: string;
  positionSizeUsd: number;
  /** % de la position encore détenu (commence à 100, diminue avec les ventes par palier) */
  remainingPercent: number;
  /** Paliers de take-profit déjà déclenchés, pour ne pas les redéclencher */
  takeProfitLevelsHit: number[];
  openedAt: string;
}

export interface RejectedToken {
  telegramId: number;
  mint: string;
  reason: string;
  score?: number;
  timestamp: string;
}

export interface ClosedTrade {
  telegramId: number;
  mint: string;
  name: string;
  symbol: string;
  creatorAddress: string | null;
  pnlUsd: number;
  pnlPercent: number;
  wasPaper: boolean;
  closedAt: string;
}

export interface BotState {
  telegramId: number;
  paperCapitalUsd: number;
  consecutiveLosses: number;
  pausedUntil: string | null;
  dailyStartCapitalUsd: number;
  dailyDate: string; // YYYY-MM-DD, pour détecter le changement de jour
  tokensScanned: number;
  tokensRejected: number;
  /** Instantanés du capital réel (paper) au fil du temps, pour calculer un vrai drawdown */
  capitalHistory: { t: string; capital: number }[];
}

interface DbSchema {
  wallets: UserWallet[];
  trades: Trade[];
  openPositions: OpenPosition[];
  rejectedTokens: RejectedToken[];
  closedTrades: ClosedTrade[];
  botStates: BotState[];
}

const DB_PATH = path.join(__dirname, "..", "data", "db.json");

function ensureDb(): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initial: DbSchema = {
      wallets: [],
      trades: [],
      openPositions: [],
      rejectedTokens: [],
      closedTrades: [],
      botStates: [],
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
  }
}

function readDb(): DbSchema {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, "utf-8");
  const data = JSON.parse(raw) as DbSchema;
  if (!data.openPositions) data.openPositions = []; // migration douce d'anciennes bases
  if (!data.rejectedTokens) data.rejectedTokens = [];
  if (!data.closedTrades) data.closedTrades = [];
  if (!data.botStates) data.botStates = [];
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
  writeDb(data);
}

export function closeAllOpenPositions(telegramId: number): void {
  const data = readDb();
  data.openPositions = data.openPositions.filter((p) => p.telegramId !== telegramId);
  writeDb(data);
}

export function clearPaperClosedTrades(telegramId: number): void {
  const data = readDb();
  data.closedTrades = data.closedTrades.filter((t) => !(t.telegramId === telegramId && t.wasPaper));
  writeDb(data);
}

export function logRejectedToken(entry: RejectedToken): void {
  const data = readDb();
  data.rejectedTokens.push(entry);
  // Ne garde que les 500 derniers rejets par utilisateur pour éviter que le fichier ne gonfle indéfiniment
  const others = data.rejectedTokens.filter((r) => r.telegramId !== entry.telegramId);
  const mine = data.rejectedTokens.filter((r) => r.telegramId === entry.telegramId).slice(-500);
  data.rejectedTokens = [...others, ...mine];
  writeDb(data);
}

export function getRejectedTokens(telegramId: number, limit = 20): RejectedToken[] {
  return readDb()
    .rejectedTokens.filter((r) => r.telegramId === telegramId)
    .slice(-limit);
}

/** Tous les rejets conservés pour cet utilisateur (jusqu'à 500, voir logRejectedToken) — pour les stats agrégées. */
export function getAllRejectedTokens(telegramId: number): RejectedToken[] {
  return readDb().rejectedTokens.filter((r) => r.telegramId === telegramId);
}

export function logClosedTrade(entry: ClosedTrade): void {
  const data = readDb();
  data.closedTrades.push(entry);
  writeDb(data);
}

export function getClosedTrades(telegramId: number): ClosedTrade[] {
  return readDb().closedTrades.filter((t) => t.telegramId === telegramId);
}

/**
 * Un créateur qui nous a déjà fait perdre gros par le passé (perte au-delà du seuil,
 * -50% par défaut) est traité comme un rugueur récidiviste connu — ses futurs tokens
 * sont automatiquement rejetés, sans dépendre d'un service tiers payant.
 */
export function isBlacklistedCreator(telegramId: number, creatorAddress: string, lossThresholdPercent = -50): boolean {
  const trades = readDb().closedTrades;
  return trades.some(
    (t) => t.telegramId === telegramId && t.creatorAddress === creatorAddress && t.pnlPercent <= lossThresholdPercent
  );
}

const defaultBotState = (telegramId: number, startingCapitalUsd: number): BotState => ({
  telegramId,
  paperCapitalUsd: startingCapitalUsd,
  consecutiveLosses: 0,
  pausedUntil: null,
  dailyStartCapitalUsd: startingCapitalUsd,
  dailyDate: new Date().toISOString().slice(0, 10),
  tokensScanned: 0,
  tokensRejected: 0,
  capitalHistory: [{ t: new Date().toISOString(), capital: startingCapitalUsd }],
});

export function getBotState(telegramId: number, startingCapitalUsd = 20): BotState {
  const data = readDb();
  const existing = data.botStates.find((s) => s.telegramId === telegramId);
  if (existing) {
    if (!existing.capitalHistory) existing.capitalHistory = [{ t: new Date().toISOString(), capital: existing.paperCapitalUsd }];
    return existing;
  }
  const fresh = defaultBotState(telegramId, startingCapitalUsd);
  data.botStates.push(fresh);
  writeDb(data);
  return fresh;
}

export function saveBotState(telegramId: number, state: BotState): void {
  const data = readDb();
  const idx = data.botStates.findIndex((s) => s.telegramId === telegramId);
  if (idx >= 0) data.botStates[idx] = state;
  else data.botStates.push(state);
  writeDb(data);
}
