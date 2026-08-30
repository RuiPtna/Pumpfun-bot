import "dotenv/config";
import { Telegraf } from "telegraf";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getOrCreateWallet, loadKeypair } from "./wallet";
import { executeTrade } from "./trade";
import {
  getTrades,
  getOpenPositions,
  getRejectedTokens,
  getClosedTrades,
  getBotState,
} from "./db";
import { AutoTrader } from "./sniper";
import { defaultParams, numericParamKeys, booleanParamKeys, StrategyParams } from "./config";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

if (!BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN manquant dans .env");
}

const allowedIds = (process.env.ALLOWED_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_ENDPOINT, "confirmed");

const paramsByUser = new Map<number, StrategyParams>();
const autoTraderByUser = new Map<number, AutoTrader>();

function getParams(telegramId: number): StrategyParams {
  if (!paramsByUser.has(telegramId)) {
    paramsByUser.set(telegramId, { ...defaultParams });
  }
  return paramsByUser.get(telegramId)!;
}

function isAllowed(telegramId: number): boolean {
  if (allowedIds.length === 0) return true;
  return allowedIds.includes(telegramId);
}

bot.use((ctx, next) => {
  const id = ctx.from?.id;
  if (!id || !isAllowed(id)) {
    ctx.reply("⛔ Tu n'es pas autorisé à utiliser ce bot.");
    return;
  }
  return next();
});

bot.start((ctx) => {
  ctx.reply(
    [
      "👋 Bienvenue sur ton bot de trading pump.fun !",
      "",
      "⚠️ Mode PAPER (simulation) actif par défaut — aucune transaction réelle tant que /live n'est pas activé explicitement.",
      "",
      "Commandes principales :",
      "/wallet — voir ou créer ton wallet",
      "/balance — voir ton solde SOL",
      "/buy <mint> <montant_sol> — acheter manuellement",
      "/sell <mint> <pourcentage|montant> — vendre manuellement",
      "/autotrade on|off — activer/désactiver le scanner automatique",
      "/dashboard — statistiques en temps réel",
      "/config — voir/régler tous les paramètres de stratégie",
      "/set <clé> <valeur> — modifier un paramètre",
      "/openpositions — positions ouvertes",
      "/pnl — gain/perte des positions ouvertes",
      "/rejected — derniers tokens rejetés et pourquoi",
      "/live on|off — activer/désactiver le trading RÉEL (danger)",
    ].join("\n")
  );
});

bot.command("wallet", (ctx) => {
  const wallet = getOrCreateWallet(ctx.from.id);
  ctx.reply(`🔑 Ton adresse wallet :\n${wallet.publicKey}\n\nDépose du SOL dessus pour trader en live.`);
});

bot.command("balance", async (ctx) => {
  const wallet = getOrCreateWallet(ctx.from.id);
  try {
    const lamports = await connection.getBalance(new PublicKey(wallet.publicKey));
    ctx.reply(`💰 Solde réel : ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (err) {
    ctx.reply(`Erreur : ${(err as Error).message}`);
  }
});

bot.command("buy", async (ctx) => {
  const [, mint, amountStr] = ctx.message.text.split(" ").filter(Boolean);
  if (!mint || !amountStr) {
    ctx.reply("Usage : /buy <adresse_du_token> <montant_en_SOL>");
    return;
  }
  const amountSol = Number(amountStr);
  if (Number.isNaN(amountSol) || amountSol <= 0) {
    ctx.reply("Le montant doit être un nombre positif.");
    return;
  }
  const wallet = getOrCreateWallet(ctx.from.id);
  const signer = loadKeypair(wallet);
  try {
    await ctx.reply(`⏳ Achat de ${amountSol} SOL sur ${mint} en cours...`);
    const signature = await executeTrade(connection, signer, {
      action: "buy",
      mint,
      amount: amountSol,
      denominatedInSol: true,
    });
    ctx.reply(`✅ Achat exécuté !\nhttps://solscan.io/tx/${signature}`);
  } catch (err) {
    ctx.reply(`❌ Échec de l'achat : ${(err as Error).message}`);
  }
});

bot.command("sell", async (ctx) => {
  const [, mint, amountStr] = ctx.message.text.split(" ").filter(Boolean);
  if (!mint || !amountStr) {
    ctx.reply("Usage : /sell <adresse_du_token> <pourcentage_ou_montant>");
    return;
  }
  const wallet = getOrCreateWallet(ctx.from.id);
  const signer = loadKeypair(wallet);
  const isPercent = amountStr.trim().endsWith("%");
  try {
    await ctx.reply(`⏳ Vente de ${amountStr} sur ${mint} en cours...`);
    const signature = await executeTrade(connection, signer, {
      action: "sell",
      mint,
      amount: isPercent ? amountStr : Number(amountStr),
      denominatedInSol: false,
    });
    ctx.reply(`✅ Vente exécutée !\nhttps://solscan.io/tx/${signature}`);
  } catch (err) {
    ctx.reply(`❌ Échec de la vente : ${(err as Error).message}`);
  }
});

bot.command("config", (ctx) => {
  const p = getParams(ctx.from.id);
  const lines = [
    `Mode : ${p.liveTrading ? "🔴 LIVE (argent réel)" : "📝 PAPER (simulation)"}`,
    `Capital de départ : $${p.startingCapitalUsd} — Position : ${p.positionPercent}% du capital`,
    `Positions max : ${p.maxOpenPositions}`,
    `Âge accepté : ${p.minAgeMinutes}-${p.maxAgeMinutes} min`,
    `Market cap accepté : $${p.minMarketCapUsd}-$${p.maxMarketCapUsd}`,
    `Score minimum pour entrer : ${p.minEntryScore}/100`,
    `Stop-loss : ${p.stopLossPercent}%`,
    `TP1 +${p.tp1Percent}% → vend ${p.tp1SellPercent}% | TP2 +${p.tp2Percent}% → vend ${p.tp2SellPercent}% | TP3 +${p.tp3Percent}% → vend ${p.tp3SellPercent}%`,
    `Trailing stop (après TP3) : ${p.trailingStopPercent}%`,
    `Perte quotidienne max : ${p.maxDailyLossPercent}%`,
    `Pause après ${p.consecutiveLossesForPause} pertes consécutives, ${p.pauseDurationMinutes} min (reprise si score ≥ ${p.minScoreAfterPause})`,
    `Slippage max : ${p.maxSlippagePercent}% — Priority fee : ${p.priorityFeeSol} SOL — Réserve : ${p.reserveSolBalance} SOL`,
    "",
    "Modifier : /set <clé> <valeur>",
    `Clés numériques : ${numericParamKeys.join(", ")}`,
    `Clés on/off : ${booleanParamKeys.join(", ")} (via /live et le mode paper)`,
  ];
  ctx.reply(lines.join("\n"));
});

bot.command("set", (ctx) => {
  const [, key, valueStr] = ctx.message.text.split(" ").filter(Boolean);
  const p = getParams(ctx.from.id);

  if (!key || !valueStr || !numericParamKeys.includes(key as keyof StrategyParams)) {
    ctx.reply(`Usage : /set <clé> <valeur>\nClés valides : ${numericParamKeys.join(", ")}`);
    return;
  }
  const value = Number(valueStr);
  if (Number.isNaN(value)) {
    ctx.reply("La valeur doit être un nombre.");
    return;
  }
  (p as any)[key] = value;
  ctx.reply(`✅ ${key} = ${value}`);
});

bot.command("live", (ctx) => {
  const [, mode] = ctx.message.text.split(" ").filter(Boolean);
  const p = getParams(ctx.from.id);

  if (mode === "on") {
    p.liveTrading = true;
    p.paperMode = false;
    ctx.reply(
      "🔴 MODE LIVE ACTIVÉ — le bot va maintenant utiliser de vrais fonds sur ton wallet. Assure-toi d'avoir testé la stratégie en paper trading et d'être à l'aise avec les paramètres actuels (/config)."
    );
  } else if (mode === "off") {
    p.liveTrading = false;
    p.paperMode = true;
    ctx.reply("📝 Retour en mode PAPER (simulation, aucun fonds réel utilisé).");
  } else {
    ctx.reply(`Usage : /live on  ou  /live off\nMode actuel : ${p.liveTrading ? "LIVE" : "PAPER"}`);
  }
});

bot.command("autotrade", (ctx) => {
  const [, mode] = ctx.message.text.split(" ").filter(Boolean);
  if (mode !== "on" && mode !== "off") {
    ctx.reply("Usage : /autotrade on  ou  /autotrade off");
    return;
  }

  const telegramId = ctx.from.id;
  const params = getParams(telegramId);

  if (mode === "on") {
    const wallet = getOrCreateWallet(telegramId);
    const signer = loadKeypair(wallet);

    let trader = autoTraderByUser.get(telegramId);
    if (!trader) {
      trader = new AutoTrader(telegramId, connection, signer, params, (msg) => {
        ctx.telegram.sendMessage(telegramId, msg).catch(() => {});
      });
      autoTraderByUser.set(telegramId, trader);
    }
    trader.start();
    ctx.reply(`🟢 Auto-trading activé en mode ${params.liveTrading ? "LIVE" : "PAPER"}.`);
  } else {
    autoTraderByUser.get(telegramId)?.stop();
    ctx.reply("🔴 Auto-trading désactivé.");
  }
});

bot.command("openpositions", (ctx) => {
  const positions = getOpenPositions(ctx.from.id);
  if (positions.length === 0) {
    ctx.reply("Aucune position ouverte.");
    return;
  }
  const lines = positions.map(
    (p) => `${p.mint} — reste ${p.remainingPercent}% — ouvert le ${new Date(p.openedAt).toLocaleString("fr-FR")}`
  );
  ctx.reply(lines.join("\n\n"));
});

bot.command("pnl", (ctx) => {
  const positions = getOpenPositions(ctx.from.id);
  if (positions.length === 0) {
    ctx.reply("Aucune position ouverte.");
    return;
  }
  const lines = positions.map((p) => {
    if (!p.lastKnownPriceSol || p.entryPriceSol <= 0) return `${p.mint.slice(0, 8)}... — PnL inconnu`;
    const gainPercent = ((p.lastKnownPriceSol - p.entryPriceSol) / p.entryPriceSol) * 100;
    const emoji = gainPercent >= 0 ? "🟢" : "🔴";
    return `${emoji} ${p.mint.slice(0, 8)}... — ${gainPercent >= 0 ? "+" : ""}${gainPercent.toFixed(1)}% — reste ${p.remainingPercent}%`;
  });
  ctx.reply(["📊 PnL des positions ouvertes :", "", ...lines].join("\n"));
});

bot.command("rejected", (ctx) => {
  const rejected = getRejectedTokens(ctx.from.id, 15);
  if (rejected.length === 0) {
    ctx.reply("Aucun rejet enregistré pour l'instant.");
    return;
  }
  const lines = rejected
    .slice()
    .reverse()
    .map((r) => `${r.mint.slice(0, 8)}... — ${r.reason}${r.score ? ` (score ${r.score}/100)` : ""}`);
  ctx.reply(["🚫 Derniers tokens rejetés :", "", ...lines].join("\n"));
});

bot.command("dashboard", (ctx) => {
  const telegramId = ctx.from.id;
  const params = getParams(telegramId);
  const state = getBotState(telegramId, params.startingCapitalUsd);
  const closedTrades = getClosedTrades(telegramId);
  const openPositions = getOpenPositions(telegramId);

  const wins = closedTrades.filter((t) => t.pnlUsd > 0);
  const losses = closedTrades.filter((t) => t.pnlUsd <= 0);
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const avgProfit = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlUsd, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlUsd, 0) / losses.length : 0;
  const totalPnl = closedTrades.reduce((s, t) => s + t.pnlUsd, 0);

  let peak = params.startingCapitalUsd;
  let runningCapital = params.startingCapitalUsd;
  let maxDrawdownPercent = 0;
  for (const t of closedTrades) {
    runningCapital += t.pnlUsd;
    peak = Math.max(peak, runningCapital);
    const drawdown = ((peak - runningCapital) / peak) * 100;
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdown);
  }

  ctx.reply(
    [
      `📊 DASHBOARD — mode ${params.liveTrading ? "🔴 LIVE" : "📝 PAPER"}`,
      "",
      `Capital simulé : $${state.paperCapitalUsd.toFixed(2)}`,
      `PnL total : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      `Positions ouvertes : ${openPositions.length}/${params.maxOpenPositions}`,
      `Trades clôturés : ${closedTrades.length} — Win rate : ${winRate.toFixed(0)}%`,
      `Gain moyen : +$${avgProfit.toFixed(2)} — Perte moyenne : $${avgLoss.toFixed(2)}`,
      `Max drawdown : -${maxDrawdownPercent.toFixed(1)}%`,
      `Tokens scannés : ${state.tokensScanned} — Rejetés : ${state.tokensRejected}`,
      `Pertes consécutives actuelles : ${state.consecutiveLosses}`,
      state.pausedUntil ? `⏸️ En pause jusqu'à ${new Date(state.pausedUntil).toLocaleString("fr-FR")}` : "▶️ Actif",
    ].join("\n")
  );
});

bot.launch();
console.log("Bot pump.fun démarré.");

import http from "http";
const PORT = process.env.PORT || 3000;
http
  .createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot pump.fun en ligne.");
  })
  .listen(PORT, () => console.log(`Serveur ping actif sur le port ${PORT}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));