/**
 * Limite le nombre RÉEL d'appels RPC par seconde (fenêtre glissante), pas seulement le nombre
 * d'appels simultanés. Une limite de "concurrence" seule ne suffit pas : avec des appels rapides,
 * le débit réel peut largement dépasser ce qu'un fournisseur comme Helius autorise, provoquant
 * des erreurs "429 Too Many Requests" en boucle qui bloquent tout le pipeline d'achat.
 */
class RpcLimiter {
  private timestamps: number[] = [];

  constructor(private maxPerSecond: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForSlot();
    return fn();
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 1000);

      if (this.timestamps.length < this.maxPerSecond) {
        this.timestamps.push(now);
        return;
      }

      const oldest = this.timestamps[0];
      const waitMs = 1000 - (now - oldest) + 20;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// Budget dédié au scan des nouveaux tokens candidats (prix + vérifications qualité).
export const rpcLimiter = new RpcLimiter(5);

// Budget SÉPARÉ, dédié au suivi des positions déjà ouvertes (ton argent en jeu). Sans ça, un
// afflux de nouveaux tokens à scanner peut retarder la mise à jour du prix de tes positions
// existantes — inacceptable, car c'est la donnée la plus critique (stop-loss, take-profit, /pnl).
export const positionRpcLimiter = new RpcLimiter(3);
