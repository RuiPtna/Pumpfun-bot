/**
 * Limite le nombre d'appels RPC simultanés à un maximum fixe, avec une file d'attente.
 * Sans ça, un afflux de nouveaux tokens à évaluer en même temps peut déclencher une rafale
 * d'appels RPC (vérification créateur, autorités, etc.) qui sature les limites du fournisseur
 * (Helius) — résultat : les appels échouent en silence et plus aucun token n'aboutit à une
 * décision d'achat.
 */
class RpcLimiter {
  private activeCount = 0;
  private queue: (() => void)[] = [];

  constructor(private maxConcurrent: number, private minDelayMs: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.activeCount < this.maxConcurrent) {
          this.activeCount++;
          setTimeout(resolve, this.minDelayMs);
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    this.activeCount--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// Un maximum de 4 appels RPC "qualité" simultanés, avec un léger espacement — suffisant pour
// rester fluide sans jamais envoyer de vraie rafale, même si des dizaines de tokens sont créés
// au même moment.
export const rpcLimiter = new RpcLimiter(4, 150);
