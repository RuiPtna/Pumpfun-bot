import "dotenv/config";
import { Telegraf } from "telegraf";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getOrCreateWallet, loadKeypair } from "./wallet";
import { executeTrade } from "./trade";
import { getTrades, logTrade, getOpenPositions } from "./db";
import { AutoTrader } from "./sniper";
import { defaultStrategy, StrategyConfig } from "./strategy";

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

// Une config + un AutoTrader par utilisateur (usage prévu : un seul utilisateur actif)
const strategyByUser = new Map<number, StrategyConfig>();
const autoTraderByUser = new Map<number, AutoTrader>();

function getStrategy(telegramId: number): StrategyConfig {
  if (!strategyByUser.has(telegramId)) {
    strategyByUser.set(telegramId, { ...defaultStrategy });
  }
  return strategyByUser.get(telegramId)!;
}

/** Vérifie que l'utilisateur est autorisé (si une liste blanche est configurée). */
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
      "Commandes disponibles :",
      "/wallet — voir ou créer ton wallet",
      "/balance — voir ton solde SOL",
      "/buy <mint> <montant_sol> — acheter un token",
      "/sell <mint> <pourcentage|montant> — vendre un token",
      "/positions — voir l'historique de tes trades",
      "/openpositions — voir tes positions actuellement ouvertes",
      "/pnl — voir le gain/perte de chaque position ouverte",
      "/config — voir et régler la stratégie automatique",
      "/set <clé> <valeur> — modifier un paramètre de la stratégie",
      "/autotrade on|off — activer/désactiver l'achat automatique",
      "",
      "⚠️ Ce bot gère ta clé privée pour toi (mode custodial). Ne partage jamais ton wallet et ne dépose que ce que tu es prêt à perdre — les meme coins sont extrêmement volatils.",
    ].join("\n")
  );
});

bot.command("wallet", (ctx) => {
  const wallet = getOrCreateWallet(ctx.from.id);
  ctx.reply(
    [
      `🔑 Ton adresse wallet :`,
      wallet.publicKey,
      "",
      "Dépose du SOL sur cette adresse pour pouvoir trader.",
    ].join("\n")
  );
});

bot.command("balance", async (ctx) => {
  const wallet = getOrCreateWallet(ctx.from.id);
  try {
    const lamports = await connection.getBalance(new PublicKey(wallet.publicKey));
    const sol = lamports / LAMPORTS_PER_SOL;
    ctx.reply(`💰 Solde : ${sol.toFixed(4)} SOL`);
  } catch (err) {
    ctx.reply(`Erreur lors de la récupération du solde : ${(err as Error).message}`);
  }
});

bot.command("buy", async (ctx) => {
  const args = ctx.message.text.split(" ").filter(Boolean);
  const [, mint, amountStr] = args;

  if (!mint || !amountStr) {
    ctx.reply("Usage : /buy <adresse_du_token> <montant_en_SOL>\nEx : /buy 2xHkesAQ...pump 0.05");
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
    logTrade({
      telegramId: ctx.from.id,
      action: "buy",
      mint,
      amountSol,
      signature,
      timestamp: new Date().toISOString(),
    });
    ctx.reply(`✅ Achat exécuté !\nhttps://solscan.io/tx/${signature}`);
  } catch (err) {
    ctx.reply(`❌ Échec de l'achat : ${(err as Error).message}`);
  }
});

bot.command("sell", async (ctx) => {
  const args = ctx.message.text.split(" ").filter(Boolean);
  const [, mint, amountStr] = args;

  if (!mint || !amountStr) {
    ctx.reply(
      "Usage : /sell <adresse_du_token> <pourcentage_ou_montant>\nEx : /sell 2xHkesAQ...pump 100%\nEx : /sell 2xHkesAQ...pump 50000"
    );
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
    logTrade({
      telegramId: ctx.from.id,
      action: "sell",
      mint,
      signature,
      timestamp: new Date().toISOString(),
    });
    ctx.reply(`✅ Vente exécutée !\nhttps://solscan.io/tx/${signature}`);
  } catch (err) {
    ctx.reply(`❌ Échec de la vente : ${(err as Error).message}`);
  }
});

bot.command("positions", (ctx) => {
  const trades = getTrades(ctx.from.id);
  if (trades.length === 0) {
    ctx.reply("Aucun trade pour l'instant.");
    return;
  }
  const lines = trades
    .slice(-15)
    .reverse()
    .map(
      (t) =>
        `${t.action === "buy" ? "🟢 ACHAT" : "🔴 VENTE"} — ${t.mint.slice(0, 8)}... — ${new Date(
          t.timestamp
        ).toLocaleString("fr-FR")}`
    );
  ctx.reply(lines.join("\n"));
});

bot.command("config", (ctx) => {
  const cfg = getStrategy(ctx.from.id);
  ctx.reply(
    [
      "⚙️ Configuration actuelle de la stratégie :",
      `Auto-trading : ${cfg.autoTradeEnabled ? "🟢 ON" : "🔴 OFF"}`,
      `Taille de position : ${cfg.positionSizeSol} SOL`,
      `Positions max simultanées : ${cfg.maxOpenPositions}`,
      `Âge token accepté : ${cfg.minTokenAgeSeconds}s - ${cfg.maxTokenAgeSeconds}s`,
      `% max détenu par le créateur : ${cfg.maxCreatorHoldingPercent}%`,
      `Acheteurs uniques min : ${cfg.minUniqueBuyers}`,
      `Stop-loss : ${cfg.stopLossPercent}%`,
      `Take-profit : ${cfg.takeProfitLevels.map((l) => `+${l.gainPercent}%→vend ${l.sellPercent}%`).join(", ")}`,
      "",
      "Pour modifier une valeur : /set <clé> <valeur>",
      "Ex : /set positionSizeSol 0.01",
      "Ex : /set stopLossPercent -20",
      "Clés modifiables : positionSizeSol, maxOpenPositions, minTokenAgeSeconds, maxTokenAgeSeconds, maxCreatorHoldingPercent, minUniqueBuyers, stopLossPercent, slippagePercent, priorityFeeSol",
    ].join("\n")
  );
});

bot.command("set", (ctx) => {
  const args = ctx.message.text.split(" ").filter(Boolean);
  const [, key, valueStr] = args;
  const cfg = getStrategy(ctx.from.id);

  const numericKeys: (keyof StrategyConfig)[] = [
    "positionSizeSol",
    "maxOpenPositions",
    "minTokenAgeSeconds",
    "maxTokenAgeSeconds",
    "maxCreatorHoldingPercent",
    "minUniqueBuyers",
    "stopLossPercent",
    "slippagePercent",
    "priorityFeeSol",
    "reserveSolBalance",
  ];

  if (!key || !valueStr || !numericKeys.includes(key as keyof StrategyConfig)) {
    ctx.reply(`Usage : /set <clé> <valeur>\nClés valides : ${numericKeys.join(", ")}`);
    return;
  }

  const value = Number(valueStr);
  if (Number.isNaN(value)) {
    ctx.reply("La valeur doit être un nombre.");
    return;
  }

  (cfg as any)[key] = value;
  ctx.reply(`✅ ${key} mis à jour : ${value}`);
});

bot.command("autotrade", (ctx) => {
  const args = ctx.message.text.split(" ").filter(Boolean);
  const mode = args[1];

  if (mode !== "on" && mode !== "off") {
    ctx.reply("Usage : /autotrade on  ou  /autotrade off");
    return;
  }

  const telegramId = ctx.from.id;
  const cfg = getStrategy(telegramId);

  if (mode === "on") {
    cfg.autoTradeEnabled = true;
    const wallet = getOrCreateWallet(telegramId);
    const signer = loadKeypair(wallet);

    let trader = autoTraderByUser.get(telegramId);
    if (!trader) {
      trader = new AutoTrader(telegramId, connection, signer, cfg, (msg) => {
        ctx.telegram.sendMessage(telegramId, msg).catch(() => {});
      });
      autoTraderByUser.set(telegramId, trader);
    }
    trader.start();
    ctx.reply("🟢 Auto-trading activé. Utilise /config pour ajuster les paramètres, /autotrade off pour arrêter.");
  } else {
    cfg.autoTradeEnabled = false;
    autoTraderByUser.get(telegramId)?.stop();
    ctx.reply("🔴 Auto-trading désactivé.");
  }
});

bot.command("pnl", (ctx) => {
  const positions = getOpenPositions(ctx.from.id);
  if (positions.length === 0) {
    ctx.reply("Aucune position ouverte.");
    return;
  }

  const lines = positions.map((p) => {
    if (!p.lastKnownPriceSol || p.entryPriceSol <= 0) {
      return `${p.mint.slice(0, 8)}... — PnL inconnu (pas encore de trade détecté sur ce token)`;
    }
    const gainPercent = ((p.lastKnownPriceSol - p.entryPriceSol) / p.entryPriceSol) * 100;
    const emoji = gainPercent >= 0 ? "🟢" : "🔴";
    return `${emoji} ${p.mint.slice(0, 8)}... — ${gainPercent >= 0 ? "+" : ""}${gainPercent.toFixed(1)}% — reste ${p.remainingPercent}% de la position — MAJ ${new Date(p.lastUpdatedAt).toLocaleTimeString("fr-FR")}`;
  });

  ctx.reply(["📊 PnL des positions ouvertes :", "", ...lines].join("\n"));
});

bot.command("openpositions", (ctx) => {
  const positions = getOpenPositions(ctx.from.id);
  if (positions.length === 0) {
    ctx.reply("Aucune position ouverte.");
    return;
  }
  const lines = positions.map(
    (p) =>
      `${p.mint.slice(0, 8)}... — reste ${p.remainingPercent}% — ouvert le ${new Date(
        p.openedAt
      ).toLocaleString("fr-FR")}`
  );
  ctx.reply(lines.join("\n"));
});

bot.launch();
console.log("Bot pump.fun démarré.");

// Mini serveur HTTP, utile uniquement pour les hébergements gratuits type Replit :
// un service externe (ex. UptimeRobot) peut "pinger" cette URL toutes les 5 min
// pour empêcher le Repl de s'endormir. Inoffensif si tu n'en as pas besoin ailleurs.
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