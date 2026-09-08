import WebSocket from "ws";

const MULTI_PLATFORM_WS = "wss://stream.pumpapi.io/";

export interface MultiPlatformCreateEvent {
  mint: string;
  name: string;
  symbol: string;
  creatorAddress: string | null;
  creatorInitialBuySol: number;
  pool: string;
}

/**
 * Se connecte à un flux tiers couvrant plusieurs plateformes de lancement de tokens Solana
 * (LetsBonk/Raydium Launchpad, Meteora, etc.), en complément de PumpPortal qui ne couvre que
 * pump.fun nativement. Service moins établi que PumpPortal/Helius — d'où le filtrage explicite
 * des créations pump.fun (déjà couvertes, plus fiablement, par le flux principal) pour éviter
 * les doublons, et l'activation optionnelle via enableMultiPlatform plutôt que systématique.
 */
export function connectMultiPlatformFeed(
  onCreate: (event: MultiPlatformCreateEvent) => void,
  onStatus: (msg: string) => void
): WebSocket {
  const ws = new WebSocket(MULTI_PLATFORM_WS);

  ws.on("open", () => {
    onStatus("🟢 Flux multi-plateformes connecté (LetsBonk et autres, en complément de pump.fun)");
  });

  ws.on("message", (raw) => {
    let data: any;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.action !== "create" || !data.mint) return;
    // Les créations pump.fun sont déjà couvertes nativement par PumpPortal, plus établi —
    // on ne garde ici que les autres plateformes pour éviter les doublons.
    if (data.pool === "pump" || data.pool === "pump-amm") return;

    onCreate({
      mint: data.mint,
      name: typeof data.name === "string" ? data.name : "?",
      symbol: typeof data.symbol === "string" ? data.symbol : "?",
      creatorAddress: typeof data.txSigner === "string" ? data.txSigner : null,
      creatorInitialBuySol: typeof data.quoteAmount === "number" ? data.quoteAmount : 0,
      pool: typeof data.pool === "string" ? data.pool : "other",
    });
  });

  ws.on("error", (err) => onStatus(`⚠️ Erreur flux multi-plateformes : ${err.message}`));

  return ws;
}
