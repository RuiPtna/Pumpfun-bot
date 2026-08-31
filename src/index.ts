import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getOrCreateWallet, loadKeypair, exportPrivateKeyBase58 } from "./wallet";
import { executeTrade } from "./trade";
import { sendSol } from "./transfer";
import { sellWithFallback } from "./sellWithFallback";
import {
  getTrades,
  getOpenPositions,
  getRejectedTokens,
  getAllRejectedTokens,
  getClosedTrades,
  getBotState,
  saveBotState,
  closeAllOpenPositions,
  clearPaperClosedTrades,
} from "./db";
import { AutoTrader, manualSellPosition } from "./sniper";
import { escapeHtml } from "./htmlEscape";
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
const pendingWithdrawals = new Map<number, { step: "address" | "amount"; address?: string }>();

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

/**
 * Édite le message existant plutôt que d'en renvoyer un nouveau. Si Telegram refuse
 * car le contenu est identique au précédent (aucun changement, ex. prix pas encore bougé),
 * on ne fait rien silencieusement — pas besoin de spammer un nouveau message pour ça.
 * On ne retombe sur un nouveau message que si l'édition échoue pour une autre raison
 * (message trop vieux, supprimé, etc.).
 */
async function editOrReply(ctx: any, text: string, keyboard: ReturnType<typeof Markup.inlineKeyboard>): Promise<void> {
  const options = { parse_mode: "HTML" as const, ...keyboard };
  try {
    await ctx.editMessageText(text, options);
  } catch (err) {
    const message = (err as Error).message || "";
    if (message.includes("message is not modified")) return;
    await ctx.reply(text, options);
  }
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 PnL", "menu_pnl"), Markup.button.callback("📂 Positions", "menu_positions")],
    [Markup.button.callback("💰 Solde", "menu_balance"), Markup.button.callback("📈 Dashboard", "menu_dashboard")],
    [Markup.button.callback("🟢 Auto ON", "menu_auto_on"), Markup.button.callback("🔴 Auto OFF", "menu_auto_off")],
    [Markup.button.callback("🚫 Rejetés", "menu_rejected"), Markup.button.callback("📜 Historique", "menu_history")],
    [Markup.button.callback("⚙️ Config", "menu_config")],
    [Markup.button.callback("🧹 Reset Paper", "start_reset_paper")],
  ]);
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
      "Utilise les boutons ci-dessous pour l'usage courant. Tape /help pour la liste complète des commandes texte.",
    ].join("\n"),
    mainMenuKeyboard()
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    [
      "📖 Commandes complètes (pour ce qui n'a pas de bouton) :",
      "",
      "/wallet — voir ou créer ton wallet",
      "/withdraw [adresse] [montant|all] — retirer du SOL vers une autre adresse",
      "/exportkey — exporter la clé privée (Phantom, Backpack...)",
      "/buy [mint] [montant_sol] — acheter manuellement",
      "/sell [mint] [pourcentage|montant] — vendre manuellement",
      "/pausefeature on|off — activer/désactiver la pause automatique après pertes",
      "/resume — lever une pause en cours immédiatement",
      "/set [clé] [valeur] — modifier un paramètre",
      "/live on|off — activer/désactiver le trading RÉEL (danger)",
      "/menu — réafficher les boutons du menu principal",
    ].join("\n")
  );
});

bot.command("menu", (ctx) => {
  ctx.reply("Menu principal :", mainMenuKeyboard());
});

bot.command("wallet", (ctx) => {
  const wallet = getOrCreateWallet(ctx.from.id);
  ctx.reply(`🔑 Ton adresse wallet :\n${wallet.publicKey}\n\nDépose du SOL dessus pour trader en live.`);
});

async function formatBalance(telegramId: number): Promise<string> {
  const wallet = getOrCreateWallet(telegramId);
  try {
    const lamports = await connection.getBalance(new PublicKey(wallet.publicKey));
    return `💰 Solde réel : ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
  } catch (err) {
    return `Erreur : ${(err as Error).message}`;
  }
}

function balanceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Ajouter SOL", "wallet_deposit"), Markup.button.callback("➖ Retirer", "wallet_withdraw_start")],
    [Markup.button.callback("🔄 Actualiser", "menu_balance")],
    [backToMenuButton()],
  ]);
}

bot.command("balance", async (ctx) => {
  ctx.reply(await formatBalance(ctx.from.id), { parse_mode: "HTML", ...balanceKeyboard() });
});

bot.command("exportkey", (ctx) => {
  const wallet = getOrCreateWallet(ctx.from.id);
  const privateKey = exportPrivateKeyBase58(wallet);
  ctx.reply(
    [
      "🔑 Voici la clé privée de ton wallet (format base58, importable dans Phantom, Backpack, etc.) :",
      "",
      privateKey,
      "",
      "⚠️ ATTENTION :",
      "— Quiconque a cette clé a un contrôle TOTAL sur ce wallet, y compris tous les fonds dessus.",
      "— Ne la partage jamais, ne la colle nulle part d'autre qu'une appli wallet de confiance.",
      "— Supprime ce message une fois la clé copiée en lieu sûr.",
      "— Si tu penses qu'elle a fuité, transfère immédiatement tes fonds vers un nouveau wallet.",
    ].join("\n")
  );
});

async function performWithdrawal(telegramId: number, address: string, amountStr: string): Promise<string> {
  const wallet = getOrCreateWallet(telegramId);
  const signer = loadKeypair(wallet);

  let amountSol: number;
  if (amountStr.toLowerCase() === "all") {
    const params = getParams(telegramId);
    const balanceLamports = await connection.getBalance(signer.publicKey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    const networkFeeBuffer = 0.001;
    amountSol = balanceSol - params.reserveSolBalance - networkFeeBuffer;
    if (amountSol <= 0) {
      return `Solde insuffisant pour retirer quoi que ce soit après la réserve de sécurité (${params.reserveSolBalance} SOL) et les frais réseau.`;
    }
  } else {
    amountSol = Number(amountStr);
    if (Number.isNaN(amountSol) || amountSol <= 0) {
      return "Le montant doit être un nombre positif, ou 'all'.";
    }
  }

  const signature = await sendSol(connection, signer, address, amountSol);
  return `✅ Retrait de ${amountSol.toFixed(4)} SOL effectué !\nhttps://solscan.io/tx/${signature}`;
}

bot.command("withdraw", async (ctx) => {
  const [, address, amountStr] = ctx.message.text.split(" ").filter(Boolean);

  if (!address || !amountStr) {
    ctx.reply("Usage : /withdraw [adresse_solana] [montant_en_sol|all]");
    return;
  }

  await ctx.reply(`⏳ Envoi vers ${address}...`);
  try {
    ctx.reply(await performWithdrawal(ctx.from.id, address, amountStr));
  } catch (err) {
    ctx.reply(`❌ Échec du retrait : ${(err as Error).message}`);
  }
});

bot.command("buy", async (ctx) => {
  const [, mint, amountStr] = ctx.message.text.split(" ").filter(Boolean);
  if (!mint || !amountStr) {
    ctx.reply("Usage : /buy [adresse_du_token] [montant_en_SOL]");
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
    ctx.reply("Usage : /sell [adresse_du_token] [pourcentage_ou_montant]");
    return;
  }
  const wallet = getOrCreateWallet(ctx.from.id);
  const signer = loadKeypair(wallet);
  const isPercent = amountStr.trim().endsWith("%");
  try {
    await ctx.reply(`⏳ Vente de ${amountStr} sur ${mint} en cours...`);
    const result = await sellWithFallback(
      connection,
      signer,
      mint,
      isPercent ? amountStr : Number(amountStr),
      15,
      0.0005
    );
    const fallbackNote = result.usedFallback ? " (via Jupiter, PumpPortal a échoué)" : "";
    ctx.reply(`✅ Vente exécutée !${fallbackNote}\nhttps://solscan.io/tx/${result.signature}`);
  } catch (err) {
    ctx.reply(`❌ Échec de la vente (PumpPortal et Jupiter ont tous les deux échoué) : ${(err as Error).message}`);
  }
});

function formatConfig(telegramId: number): string {
  const p = getParams(telegramId);
  return [
    `Mode : ${p.liveTrading ? "🔴 LIVE (argent réel)" : "📝 PAPER (simulation)"}`,
    `Capital de départ : $${p.startingCapitalUsd} — Position : ${p.positionPercent}% du capital`,
    `Positions max : ${p.maxOpenPositions}`,
    `Âge accepté : ${p.minAgeMinutes}-${p.maxAgeMinutes} min`,
    `Market cap accepté : $${p.minMarketCapUsd}-$${p.maxMarketCapUsd}`,
    `Score minimum pour entrer : ${p.minEntryScore}/100`,
    `Concentration holders max : créateur ${p.maxCreatorHoldingPercent}%, plus gros holder ${p.maxTopHolderPercent}%, top 10 ${p.maxTop10HolderPercent}%`,
    `Stop-loss : ${p.stopLossPercent}%`,
    `TP1 +${p.tp1Percent}% → vend ${p.tp1SellPercent}% | TP2 +${p.tp2Percent}% → vend ${p.tp2SellPercent}% | TP3 +${p.tp3Percent}% → vend ${p.tp3SellPercent}% | TP4 +${p.tp4Percent}% → vend ${p.tp4SellPercent}%`,
    `Trailing stop (après TP3) : ${p.trailingStopPercent}%`,
    `Durée max sans TP touché : ${p.maxHoldMinutes} min`,
    `Perte quotidienne max : ${p.maxDailyLossPercent}%`,
    `Pause après pertes : ${p.pauseFeatureEnabled ? "🟢 activée" : "🔴 désactivée"} (${p.consecutiveLossesForPause} pertes consécutives, ${p.pauseDurationMinutes} min, reprise si score ≥ ${p.minScoreAfterPause})`,
    `Slippage max : ${p.maxSlippagePercent}% — Priority fee : ${p.priorityFeeSol} SOL — Réserve : ${p.reserveSolBalance} SOL`,
    "",
    "Modifier : /set [clé] [valeur]",
    `Clés numériques : ${numericParamKeys.join(", ")}`,
    `Clés on/off : ${booleanParamKeys.join(", ")} (via /live et le mode paper)`,
  ].join("\n");
}

bot.command("config", (ctx) => {
  ctx.reply(formatConfig(ctx.from.id), { parse_mode: "HTML" });
});

bot.command("set", (ctx) => {
  const [, key, valueStr] = ctx.message.text.split(" ").filter(Boolean);
  const p = getParams(ctx.from.id);

  if (!key || !valueStr || !numericParamKeys.includes(key as keyof StrategyParams)) {
    ctx.reply(`Usage : /set [clé] [valeur]\nClés valides : ${numericParamKeys.join(", ")}`);
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

function setAutotrade(telegramId: number, mode: "on" | "off", sendMessage: (msg: string) => void): string {
  const params = getParams(telegramId);

  if (mode === "on") {
    const wallet = getOrCreateWallet(telegramId);
    const signer = loadKeypair(wallet);

    let trader = autoTraderByUser.get(telegramId);
    if (!trader) {
      trader = new AutoTrader(telegramId, connection, signer, params, sendMessage);
      autoTraderByUser.set(telegramId, trader);
    }
    trader.start();
    return `🟢 Auto-trading activé en mode ${params.liveTrading ? "LIVE" : "PAPER"}.`;
  } else {
    autoTraderByUser.get(telegramId)?.stop();
    return "🔴 Auto-trading désactivé.";
  }
}

bot.command("autotrade", (ctx) => {
  const [, mode] = ctx.message.text.split(" ").filter(Boolean);
  if (mode !== "on" && mode !== "off") {
    ctx.reply("Usage : /autotrade on  ou  /autotrade off");
    return;
  }
  const telegramId = ctx.from.id;
  ctx.reply(setAutotrade(telegramId, mode, (msg) => ctx.telegram.sendMessage(telegramId, msg, { parse_mode: "HTML" }).catch(() => {})));
});

function formatOpenPositions(telegramId: number): string {
  const positions = getOpenPositions(telegramId);
  if (positions.length === 0) return "Aucune position ouverte.";
  const lines = positions.map(
    (p) =>
      `<b>${escapeHtml(p.symbol)}</b> (${escapeHtml(p.name)})\n<code>${p.mint}</code>\nEntrée à <b>$${p.entryMarketCapUsd.toFixed(0)}</b> de market cap — reste ${p.remainingPercent}% — ouvert le ${new Date(p.openedAt).toLocaleString("fr-FR")}`
  );
  return lines.join("\n\n");
}

bot.command("openpositions", (ctx) => {
  ctx.reply(formatOpenPositions(ctx.from.id), { parse_mode: "HTML" });
});

function formatPnl(telegramId: number): string {
  const positions = getOpenPositions(telegramId);
  if (positions.length === 0) return "Aucune position ouverte.";

  const lines = positions.map((p) => {
    if (!p.lastKnownMarketCapUsd || p.entryMarketCapUsd <= 0) return `<b>${escapeHtml(p.symbol)}</b> (${escapeHtml(p.name)}) — PnL inconnu`;
    const gainPercent = ((p.lastKnownMarketCapUsd - p.entryMarketCapUsd) / p.entryMarketCapUsd) * 100;
    const remainingValueUsd = p.positionSizeUsd * (p.remainingPercent / 100);
    const pnlUsd = remainingValueUsd * (gainPercent / 100);
    const emoji = gainPercent >= 0 ? "🟢" : "🔴";
    const pnlSign = pnlUsd >= 0 ? "+" : "";
    return `${emoji} <b>${escapeHtml(p.symbol)}</b> (${escapeHtml(p.name)}) — <b>${gainPercent >= 0 ? "+" : ""}${gainPercent.toFixed(1)}%</b> (${pnlSign}$${pnlUsd.toFixed(2)}) — investi $${p.positionSizeUsd.toFixed(2)} — entrée $${p.entryMarketCapUsd.toFixed(0)} → actuel $${p.lastKnownMarketCapUsd.toFixed(0)} — reste ${p.remainingPercent}%`;
  });

  const totalPnlUsd = positions.reduce((sum, p) => {
    if (!p.lastKnownMarketCapUsd || p.entryMarketCapUsd <= 0) return sum;
    const gainPercent = ((p.lastKnownMarketCapUsd - p.entryMarketCapUsd) / p.entryMarketCapUsd) * 100;
    const remainingValueUsd = p.positionSizeUsd * (p.remainingPercent / 100);
    return sum + remainingValueUsd * (gainPercent / 100);
  }, 0);

  return [
    "📊 PnL des positions ouvertes :",
    "",
    ...lines,
    "",
    `Total non réalisé : ${totalPnlUsd >= 0 ? "+" : ""}$${totalPnlUsd.toFixed(2)}`,
  ].join("\n");
}

function pnlKeyboard(telegramId: number) {
  const positions = getOpenPositions(telegramId);
  const sellButtons = positions.map((p) => [Markup.button.callback(`💸 Vendre ${p.symbol}`, `sell_${p.mint}`)]);
  return Markup.inlineKeyboard([...sellButtons, [Markup.button.callback("🔄 Actualiser", "menu_pnl")], [backToMenuButton()]]);
}

bot.command("pnl", (ctx) => {
  ctx.reply(formatPnl(ctx.from.id), { parse_mode: "HTML", ...pnlKeyboard(ctx.from.id) });
});

function formatRejected(telegramId: number): string {
  const rejected = getRejectedTokens(telegramId, 15);
  if (rejected.length === 0) return "Aucun rejet enregistré pour l'instant.";
  const lines = rejected
    .slice()
    .reverse()
    .map((r) => `${r.mint.slice(0, 8)}... — ${r.reason}${r.score ? ` (score ${r.score}/100)` : ""}`);
  return ["🚫 Derniers tokens rejetés :", "", ...lines].join("\n");
}

/** Regroupe un motif de rejet précis (avec ses chiffres variables) sous une catégorie stable. */
function categorizeRejectionReason(reason: string): string {
  const categories: [string, string][] = [
    ["trop jeune", "⏳ Trop jeune"],
    ["trop vieux", "⏳ Trop vieux"],
    ["market cap trop faible", "📉 Market cap trop faible"],
    ["market cap trop élevé", "📈 Market cap trop élevé"],
    ["pas assez de SOL réellement investi", "💧 Pas assez de SOL investi (token mort)"],
    ["créateur détient encore", "👤 Créateur détient trop"],
    ["plus gros holder détient", "🐋 Plus gros holder trop concentré"],
    ["top 10 holders détiennent", "🐋 Top 10 holders trop concentrés"],
    ["fenêtre d'observation expirée", "⏱️ Expiré sans setup validé"],
    ["nombre maximum de positions", "🔒 Limite de positions atteinte"],
    ["limite de perte quotidienne", "🛑 Limite de perte quotidienne"],
    ["bot en pause", "⏸️ Bot en pause"],
    ["solde insuffisant", "💰 Solde insuffisant"],
  ];
  for (const [needle, label] of categories) {
    if (reason.includes(needle)) return label;
  }
  return "❓ Autre";
}

function formatRejectedStats(telegramId: number): string {
  const rejected = getAllRejectedTokens(telegramId);
  if (rejected.length === 0) return "Aucun rejet enregistré pour l'instant.";

  const counts = new Map<string, number>();
  for (const r of rejected) {
    const category = categorizeRejectionReason(r.reason);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = rejected.length;
  const lines = sorted.map(([label, count]) => `${label} : ${count} (${((count / total) * 100).toFixed(0)}%)`);

  return [`📊 Motifs de rejet — ${total} tokens au total`, "", ...lines].join("\n");
}

function formatHistory(telegramId: number, limit = 20): string {
  const trades = getClosedTrades(telegramId)
    .slice()
    .reverse()
    .slice(0, limit);
  if (trades.length === 0) return "Aucun trade clôturé pour l'instant.";

  const lines = trades.map((t) => {
    const emoji = t.pnlUsd >= 0 ? "🟢" : "🔴";
    const sign = t.pnlUsd >= 0 ? "+" : "";
    const mode = t.wasPaper ? "📝" : "🔴";
    const date = new Date(t.closedAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `${emoji} ${mode} <b>${escapeHtml(t.symbol)}</b> (${escapeHtml(t.name)}) — <b>${t.pnlPercent >= 0 ? "+" : ""}${t.pnlPercent.toFixed(1)}%</b> (${sign}$${t.pnlUsd.toFixed(2)}) — ${date}`;
  });

  return [`📜 Historique des ${trades.length} derniers trades :`, "", ...lines].join("\n");
}

function historyKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Actualiser", "menu_history")],
    [backToMenuButton()],
  ]);
}

bot.command("history", (ctx) => {
  ctx.reply(formatHistory(ctx.from.id), { parse_mode: "HTML", ...historyKeyboard() });
});

bot.action("menu_history", async (ctx) => {
  await ctx.answerCbQuery();
  await editOrReply(ctx, formatHistory(ctx.from!.id), historyKeyboard());
});

function rejectedKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Voir les stats groupées", "menu_rejectedstats")],
    [backToMenuButton()],
  ]);
}

function rejectedStatsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Actualiser", "menu_rejectedstats")],
    [backToMenuButton()],
  ]);
}

bot.command("rejected", (ctx) => {
  ctx.reply(formatRejected(ctx.from.id), { parse_mode: "HTML", ...rejectedKeyboard() });
});

bot.command("rejectedstats", (ctx) => {
  ctx.reply(formatRejectedStats(ctx.from.id), { parse_mode: "HTML", ...rejectedStatsKeyboard() });
});

bot.action("menu_rejectedstats", async (ctx) => {
  await ctx.answerCbQuery();
  await editOrReply(ctx, formatRejectedStats(ctx.from!.id), rejectedStatsKeyboard());
});

bot.command("pausefeature", (ctx) => {
  const [, mode] = ctx.message.text.split(" ").filter(Boolean);
  const params = getParams(ctx.from.id);

  if (mode === "on") {
    params.pauseFeatureEnabled = true;
    ctx.reply("🟢 Pause automatique après pertes consécutives : activée.");
  } else if (mode === "off") {
    params.pauseFeatureEnabled = false;
    ctx.reply("🔴 Pause automatique après pertes consécutives : désactivée. Le bot continuera de trader même après plusieurs pertes d'affilée.");
  } else {
    ctx.reply(`Usage : /pausefeature on  ou  /pausefeature off\nÉtat actuel : ${params.pauseFeatureEnabled ? "activée" : "désactivée"}`);
  }
});

bot.command("resume", (ctx) => {
  const telegramId = ctx.from.id;
  const params = getParams(telegramId);
  const state = getBotState(telegramId, params.startingCapitalUsd);

  if (!state.pausedUntil) {
    ctx.reply("Le bot n'est pas en pause actuellement.");
    return;
  }

  state.pausedUntil = null;
  state.consecutiveLosses = 0;
  saveBotState(telegramId, state);
  ctx.reply("▶️ Pause levée immédiatement, compteur de pertes consécutives remis à zéro.");
});

function formatDashboard(telegramId: number): string {
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
    // Bornée à 100% : au-delà, ça reflète un désaccord entre ce calcul simplifié (qui rejoue les
    // trades séquentiellement sur un capital de départ fixe) et le vrai capital simulé qui, lui,
    // ne peut pas descendre sous 0 — pas une vraie perte de plus de 100%.
    const drawdown = Math.min(100, ((peak - runningCapital) / peak) * 100);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdown);
  }

  const openPositionsValueUsd = openPositions.reduce((sum, p) => {
    if (!p.lastKnownMarketCapUsd || p.entryMarketCapUsd <= 0) {
      // Pas encore de prix connu pour ce token — on compte le coût d'entrée par défaut,
      // plus juste que de l'ignorer complètement dans le total.
      return sum + p.positionSizeUsd * (p.remainingPercent / 100);
    }
    const gainPercent = ((p.lastKnownMarketCapUsd - p.entryMarketCapUsd) / p.entryMarketCapUsd) * 100;
    const costBasisRemaining = p.positionSizeUsd * (p.remainingPercent / 100);
    return sum + costBasisRemaining * (1 + gainPercent / 100);
  }, 0);
  const totalPortfolioValue = state.paperCapitalUsd + openPositionsValueUsd;

  return [
    `📊 <b>DASHBOARD</b> — mode ${params.liveTrading ? "🔴 LIVE" : "📝 PAPER"}`,
    "",
    `Valeur totale du portefeuille : <b>$${totalPortfolioValue.toFixed(2)}</b>`,
    `— dont cash disponible : $${state.paperCapitalUsd.toFixed(2)}`,
    `— dont positions ouvertes : $${openPositionsValueUsd.toFixed(2)}`,
    `PnL total : <b>${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}</b>`,
    `Positions ouvertes : ${openPositions.length}/${params.maxOpenPositions}`,
    `Trades clôturés : ${closedTrades.length} — Win rate : ${winRate.toFixed(0)}%`,
    `Gain moyen : +$${avgProfit.toFixed(2)} — Perte moyenne : $${avgLoss.toFixed(2)}`,
    `Max drawdown : -${maxDrawdownPercent.toFixed(1)}%`,
    `Tokens scannés : ${state.tokensScanned} — Rejetés : ${state.tokensRejected}`,
    `Pertes consécutives actuelles : ${state.consecutiveLosses}`,
    state.pausedUntil && params.pauseFeatureEnabled
      ? `⏸️ En pause jusqu'à ${new Date(state.pausedUntil).toLocaleString("fr-FR")}`
      : "▶️ Actif",
    params.liveTrading ? "\n⚠️ En mode LIVE, le cash affiché ici reste le compteur paper — utilise /balance pour ton vrai solde SOL." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function backToMenuButton() {
  return Markup.button.callback("↩️ Menu", "menu_home");
}

function dashboardKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Actualiser", "menu_dashboard")],
    [backToMenuButton()],
  ]);
}

function resetPaperData(telegramId: number): string {
  const params = getParams(telegramId);
  const state = getBotState(telegramId, params.startingCapitalUsd);

  state.paperCapitalUsd = params.startingCapitalUsd;
  state.consecutiveLosses = 0;
  state.pausedUntil = null;
  state.tokensScanned = 0;
  state.tokensRejected = 0;
  saveBotState(telegramId, state);

  clearPaperClosedTrades(telegramId);

  let positionsNote = "";
  if (!params.liveTrading) {
    closeAllOpenPositions(telegramId);
    positionsNote = " et les positions ouvertes ont été effacées";
  } else {
    positionsNote = " (positions ouvertes conservées car le mode LIVE est actif)";
  }

  return `🧹 Données paper réinitialisées : capital remis à $${params.startingCapitalUsd}, historique de trades simulés effacé${positionsNote}.`;
}

function resetConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirmer la réinitialisation", "confirm_reset_paper")],
    [Markup.button.callback("❌ Annuler", "cancel_reset_paper")],
  ]);
}

bot.command("resetpaper", (ctx) => {
  ctx.reply(
    "⚠️ Ça va remettre le capital simulé à zéro et effacer tout l'historique de trades en mode paper (les positions ouvertes en paper seront aussi fermées). Confirmer ?",
    resetConfirmKeyboard()
  );
});

bot.action("start_reset_paper", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    "⚠️ Ça va remettre le capital simulé à zéro et effacer tout l'historique de trades en mode paper (les positions ouvertes en paper seront aussi fermées). Confirmer ?",
    resetConfirmKeyboard()
  );
});

bot.action("confirm_reset_paper", async (ctx) => {
  await ctx.answerCbQuery();
  const result = resetPaperData(ctx.from!.id);
  await editOrReply(ctx, result, mainMenuKeyboard());
});

bot.action("cancel_reset_paper", async (ctx) => {
  await ctx.answerCbQuery();
  await editOrReply(ctx, "Réinitialisation annulée.", mainMenuKeyboard());
});

bot.command("dashboard", (ctx) => {
  ctx.reply(formatDashboard(ctx.from.id), { parse_mode: "HTML", ...dashboardKeyboard() });
});

// --- Boutons du menu principal ---
bot.action("menu_pnl", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from!.id;
  const text = formatPnl(telegramId);
  await editOrReply(ctx, text, pnlKeyboard(telegramId));
});

bot.action(/^sell_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from!.id;
  const mint = ctx.match[1];

  const wallet = getOrCreateWallet(telegramId);
  const signer = loadKeypair(wallet);
  const params = getParams(telegramId);

  await ctx.reply(`⏳ Vente en cours sur ${mint.slice(0, 8)}...`);
  try {
    const signature = await manualSellPosition(telegramId, mint, connection, signer, params);
    const note = params.liveTrading ? `\nhttps://solscan.io/tx/${signature}` : " (paper)";
    await ctx.reply(`✅ Position vendue intégralement.${note}`);
  } catch (err) {
    await ctx.reply(`❌ Échec de la vente : ${(err as Error).message}`);
  }

  // Rafraîchit l'affichage du PnL pour refléter la position fermée
  const text = formatPnl(telegramId);
  await editOrReply(ctx, text, pnlKeyboard(telegramId));
});
bot.action("menu_positions", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(formatOpenPositions(ctx.from!.id), { parse_mode: "HTML" });
});
bot.action("menu_balance", async (ctx) => {
  await ctx.answerCbQuery();
  const text = await formatBalance(ctx.from!.id);
  await editOrReply(ctx, text, balanceKeyboard());
});

bot.action("wallet_deposit", async (ctx) => {
  await ctx.answerCbQuery();
  const wallet = getOrCreateWallet(ctx.from!.id);
  ctx.reply(`📥 Adresse de dépôt :\n${wallet.publicKey}\n\nEnvoie du SOL directement sur cette adresse depuis n'importe quel wallet ou exchange.`);
});

bot.action("wallet_withdraw_start", async (ctx) => {
  await ctx.answerCbQuery();
  pendingWithdrawals.set(ctx.from!.id, { step: "address" });
  ctx.reply("À quelle adresse Solana veux-tu envoyer des SOL ? Colle l'adresse complète.");
});
bot.action("menu_dashboard", async (ctx) => {
  await ctx.answerCbQuery();
  const text = formatDashboard(ctx.from!.id);
  await editOrReply(ctx, text, dashboardKeyboard());
});

bot.action("menu_home", async (ctx) => {
  await ctx.answerCbQuery();
  await editOrReply(ctx, "Menu principal :", mainMenuKeyboard());
});
bot.action("menu_rejected", async (ctx) => {
  await ctx.answerCbQuery();
  await editOrReply(ctx, formatRejected(ctx.from!.id), rejectedKeyboard());
});
bot.action("menu_config", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(formatConfig(ctx.from!.id), { parse_mode: "HTML" });
});
bot.action("menu_auto_on", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from!.id;
  ctx.reply(setAutotrade(telegramId, "on", (msg) => ctx.telegram.sendMessage(telegramId, msg, { parse_mode: "HTML" }).catch(() => {})));
});
bot.action("menu_auto_off", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from!.id;
  ctx.reply(setAutotrade(telegramId, "off", (msg) => ctx.telegram.sendMessage(telegramId, msg, { parse_mode: "HTML" }).catch(() => {})));
});

// Capture le texte libre uniquement pour le flux guidé de retrait (adresse puis montant).
// Placé après toutes les commandes : un message commençant par "/" est déjà intercepté
// par le bon bot.command() avant d'arriver ici.
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id;
  const pending = pendingWithdrawals.get(telegramId);
  if (!pending) return;

  const text = ctx.message.text.trim();

  if (pending.step === "address") {
    try {
      new PublicKey(text); // valide le format, lève une erreur sinon
    } catch {
      ctx.reply("Adresse invalide, réessaie (colle l'adresse Solana complète) :");
      return;
    }
    pendingWithdrawals.set(telegramId, { step: "amount", address: text });
    ctx.reply("Combien de SOL veux-tu envoyer ? (un nombre, ou 'all' pour tout retirer)");
    return;
  }

  if (pending.step === "amount") {
    const address = pending.address!;
    pendingWithdrawals.delete(telegramId); // on consomme la demande, succès ou échec

    if (text.toLowerCase() !== "all" && (Number.isNaN(Number(text)) || Number(text) <= 0)) {
      ctx.reply("Montant invalide, retape /withdraw pour recommencer si besoin.");
      return;
    }

    await ctx.reply(`⏳ Envoi vers ${address}...`);
    try {
      ctx.reply(await performWithdrawal(telegramId, address, text));
    } catch (err) {
      ctx.reply(`❌ Échec du retrait : ${(err as Error).message}`);
    }
  }
});

async function startBot(): Promise<void> {
  // Nettoie toute session de longue durée (long-polling) restée ouverte côté Telegram —
  // utile après avoir testé le bot sur un autre hébergement (Replit) précédemment.
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  console.log("Webhook nettoyé, updates en attente supprimées.");

  // Menu natif Telegram (icône "/" à côté du champ de texte) — rend les commandes
  // découvrables sans avoir à connaître /help par cœur.
  await bot.telegram.setMyCommands([
    { command: "start", description: "Menu principal" },
    { command: "menu", description: "Réafficher les boutons du menu" },
    { command: "help", description: "Liste complète des commandes" },
    { command: "wallet", description: "Voir/créer le wallet" },
    { command: "balance", description: "Solde SOL" },
    { command: "withdraw", description: "Retirer des SOL" },
    { command: "exportkey", description: "Exporter la clé privée" },
    { command: "buy", description: "Acheter un token manuellement" },
    { command: "sell", description: "Vendre un token manuellement" },
    { command: "autotrade", description: "Activer/désactiver le bot" },
    { command: "dashboard", description: "Statistiques en temps réel" },
    { command: "pnl", description: "PnL des positions ouvertes" },
    { command: "openpositions", description: "Positions actuellement ouvertes" },
    { command: "history", description: "Historique des trades clôturés" },
    { command: "rejected", description: "Derniers tokens rejetés" },
    { command: "rejectedstats", description: "Stats des rejets par catégorie" },
    { command: "config", description: "Voir la configuration" },
    { command: "set", description: "Modifier un paramètre" },
    { command: "live", description: "Basculer paper/live" },
    { command: "pausefeature", description: "Pause après pertes consécutives" },
    { command: "resume", description: "Lever une pause en cours" },
    { command: "resetpaper", description: "Réinitialiser le paper trading" },
  ]);
  console.log("Menu de commandes Telegram configuré.");

  await bot.launch();
  console.log("Bot pump.fun démarré.");
}

startBot().catch((err) => {
  console.error("❌ Échec critique au démarrage du bot :", err);
  process.exit(1);
});

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
