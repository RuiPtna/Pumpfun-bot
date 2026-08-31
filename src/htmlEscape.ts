/**
 * Échappe les caractères spéciaux HTML (&, <, >) avant de les insérer dans un
 * message Telegram envoyé avec parse_mode: "HTML". Indispensable pour tout texte
 * qui vient d'une source externe non fiable — comme le nom ou le symbole d'un
 * token, choisis librement par son créateur et pouvant contenir n'importe quoi.
 * Sans ça, un nom de token contenant "<" ou "&" ferait planter l'envoi du message.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
