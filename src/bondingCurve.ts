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

export async function fetchBondingCurveMarketCap(
  connection: Connection,
  bondingCurveKey: string,
  solPriceUsd: number
): Promise<BondingCurveSnapshot | null> {
  try {
    const accountInfo = await connection.getAccountInfo(new PublicKey(bondingCurveKey));
    if (!accountInfo) return null;

    const state = parseBondingCurveAccount(accountInfo.data);
    if (!state) return null;
    if (state.virtualSolReserves <= 0n || state.virtualTokenReserves <= 0n) return null;

    const priceSolPerToken =
      Number(state.virtualSolReserves) / 10 ** SOL_DECIMALS / (Number(state.virtualTokenReserves) / 10 ** TOKEN_DECIMALS);
    const totalSupplyTokens = Number(state.tokenTotalSupply) / 10 ** TOKEN_DECIMALS;
    const marketCapSol = priceSolPerToken * totalSupplyTokens;

    // Garde-fou : une valeur aberrante (ex. si le layout ne correspond plus au programme actuel)
    // vaut mieux être ignorée que de déclencher un trade sur une donnée fausse.
    if (!Number.isFinite(marketCapSol) || marketCapSol <= 0 || marketCapSol > 100_000_000) return null;

    const realTokenReservesTokens = Number(state.realTokenReserves) / 10 ** TOKEN_DECIMALS;
    const rawProgress =
      100 - ((realTokenReservesTokens - CURVE_GRADUATION_REAL_TOKENS) * 100) / CURVE_START_REAL_TOKENS;
    const bondingCurveProgressPercent = Math.max(0, Math.min(100, rawProgress));

    return {
      marketCapUsd: marketCapSol * solPriceUsd,
      complete: state.complete,
      realSolReserves: Number(state.realSolReserves) / 10 ** SOL_DECIMALS,
      bondingCurveProgressPercent,
    };
  } catch {
    return null;
  }
}
