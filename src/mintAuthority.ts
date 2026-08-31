import { Connection, PublicKey } from "@solana/web3.js";

export interface AuthorityCheck {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
}

/**
 * Vérifie que l'autorité de mint (le créateur peut émettre plus de tokens à volonté,
 * diluant tout le monde) et l'autorité de freeze (le créateur peut geler ton wallet et
 * t'empêcher de vendre — le piège honeypot classique) sont bien révoquées.
 *
 * Les lancements standards pump.fun révoquent normalement les deux automatiquement,
 * donc ce filtre coûte presque toujours rien en pratique — mais protège contre toute
 * anomalie ou plateforme clonée qui ne suivrait pas cette convention.
 */
export async function checkMintAuthorities(connection: Connection, mint: string): Promise<AuthorityCheck | null> {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const parsed = (info.value?.data as any)?.parsed?.info;
    if (!parsed) return null;

    return {
      mintAuthorityRevoked: parsed.mintAuthority === null,
      freezeAuthorityRevoked: parsed.freezeAuthority === null,
    };
  } catch {
    return null;
  }
}
