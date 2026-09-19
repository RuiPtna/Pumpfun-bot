import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Layout du compte "BondingCurve" du programme pump.fun (après le discriminateur
 * Anchor de 8 octets), documenté publiquement dans plusieurs implémentations
 * open-source (ex. chainstacklabs/pump-fun-bot) :
 *
 * offset  0-8   : discriminateur Anchor
 * offset  8-16  : virtualTokenReserves (u64)
 * offset 16-24  : virtualSolReserves (u64)
 * offset 24-32  : realTokenReserves (u64)
 * offset 32-40  : realSolReserves (u64)
 * offset 40-48  : tokenTotalSupply (u64)
 * offset 48     : complete (bool) — true une fois le token gradué vers PumpSwap
 *
 * ⚠️ Ce layout n'est pas issu de la documentation officielle de PumpPortal —
 * si pump.fun modifie son programme, cette lecture peut casser silencieusement.
 * Un garde-fou est en place : si les valeurs semblent incohérentes, on ignore
 * la lecture plutôt que de trader sur une donnée fausse.
 */
export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

/** Programme pump.fun (bonding curve), identique sur Mainnet et Devnet. */
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

/**
 * Dérive l'adresse du compte bonding curve à partir du seul mint.
 *
 * C'est une PDA de seeds ["bonding-curve", mint] sur le programme pump.fun — documenté
 * officiellement. Conséquence importante : on n'a JAMAIS besoin qu'un événement nous fournisse
 * cette adresse. Un token détecté par migration, par copy-trading, ou dont l'événement de
 * création n'a pas transmis la clé, reste lisible on-chain instantanément.
 *
 * Sans ça, ces tokens retombaient sur DexScreener — sujet à limite de débit et qui n'indexe
 * pas immédiatement un lancement récent, d'où les "prix non actualisés".
 */
export function deriveBondingCurvePda(mint: string): string | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
      PUMP_PROGRAM_ID
    );
    return pda.toBase58();
  } catch {
    return null;
  }
}

const SOL_DECIMALS = 9;
const TOKEN_DECIMALS = 6; // standard pour les tokens pump.fun

function parseBondingCurveAccount(data: Buffer): BondingCurveState | null {
  if (data.length < 49) return null;
  try {
    return {
      virtualTokenReserves: data.readBigUInt64LE(8),
      virtualSolReserves: data.readBigUInt64LE(16),
      realTokenReserves: data.readBigUInt64LE(24),
      realSolReserves: data.readBigUInt64LE(32),
      tokenTotalSupply: data.readBigUInt64LE(40),
      complete: data.readUInt8(48) === 1,
    };
  } catch {
    return null;
  }
}

export interface BondingCurveSnapshot {
  marketCapUsd: number;
  complete: boolean;
  /** SOL réellement déposé par de vrais acheteurs (hors réserves virtuelles de départ) */
  realSolReserves: number;
  /**
   * % de progression officiel de la bonding curve (0-100), calculé avec les constantes
   * connues du protocole pump.fun : la curve démarre avec 793 100 000 tokens "réels" en
   * réserve et atteint la graduation quand il n'en reste plus que 206 900 000 (= 100%).
   * Un token déjà bien avancé sur sa curve a survécu à la fenêtre la plus risquée (les
   * tout premiers instants) — c'est un signal de résilience à part entière.
   */
  bondingCurveProgressPercent: number;
}

const CURVE_START_REAL_TOKENS = 793_100_000;
const CURVE_GRADUATION_REAL_TOKENS = 206_900_000;

/**
 * Résultat distinguant explicitement les cas — indispensable : un échec technique et un compte
 * inexistant demandent des réactions OPPOSÉES.
 *
 * - "ok"        : lecture valide.
 * - "not_found" : le compte n'existe pas → le token a gradué (ou n'est pas un token pump.fun).
 *                 DexScreener devient alors la bonne source.
 * - "error"     : échec technique (RPC, données illisibles). Le token est probablement TOUJOURS
 *                 pré-migration : basculer sur DexScreener donnerait un market cap calculé sur
 *                 une base différente. Il faut réessayer, pas changer de source.
 */
export type BondingCurveResult =
  | { status: "ok"; snapshot: BondingCurveSnapshot }
  | { status: "not_found" }
  | { status: "error" };

export async function fetchBondingCurveResult(
  connection: Connection,
  bondingCurveKey: string,
  solPriceUsd: number
): Promise<BondingCurveResult> {
  try {
    const accountInfo = await connection.getAccountInfo(new PublicKey(bondingCurveKey));
    if (!accountInfo) return { status: "not_found" };

    const state = parseBondingCurveAccount(accountInfo.data);
    if (!state) return { status: "error" };
    if (state.virtualSolReserves <= 0n || state.virtualTokenReserves <= 0n) return { status: "error" };

    const priceSolPerToken =
      Number(state.virtualSolReserves) / 10 ** SOL_DECIMALS / (Number(state.virtualTokenReserves) / 10 ** TOKEN_DECIMALS);
    const totalSupplyTokens = Number(state.tokenTotalSupply) / 10 ** TOKEN_DECIMALS;
    const marketCapSol = priceSolPerToken * totalSupplyTokens;

    // Garde-fou : une valeur aberrante (ex. si le layout ne correspond plus au programme actuel)
    // vaut mieux être ignorée que de déclencher un trade sur une donnée fausse.
    if (!Number.isFinite(marketCapSol) || marketCapSol <= 0 || marketCapSol > 100_000_000) return { status: "error" };

    const realTokenReservesTokens = Number(state.realTokenReserves) / 10 ** TOKEN_DECIMALS;
    const rawProgress =
      100 - ((realTokenReservesTokens - CURVE_GRADUATION_REAL_TOKENS) * 100) / CURVE_START_REAL_TOKENS;
    const bondingCurveProgressPercent = Math.max(0, Math.min(100, rawProgress));

    return {
      status: "ok",
      snapshot: {
        marketCapUsd: marketCapSol * solPriceUsd,
        complete: state.complete,
        realSolReserves: Number(state.realSolReserves) / 10 ** SOL_DECIMALS,
        bondingCurveProgressPercent,
      },
    };
  } catch {
    return { status: "error" };
  }
}

/** Ancienne signature, conservée pour les appels qui n'ont pas besoin de distinguer les cas. */
export async function fetchBondingCurveMarketCap(
  connection: Connection,
  bondingCurveKey: string,
  solPriceUsd: number
): Promise<BondingCurveSnapshot | null> {
  const result = await fetchBondingCurveResult(connection, bondingCurveKey, solPriceUsd);
  return result.status === "ok" ? result.snapshot : null;
}
