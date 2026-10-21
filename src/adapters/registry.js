/** Adapter capabilities are local code, never selected by remote issue content. */
export class AdapterRegistry {
  #factories = new Map();
  register(type, factory) {
    if (this.#factories.has(type)) throw new Error(`Adapter type already registered: ${type}`);
    this.#factories.set(type, factory);
    return () => this.#factories.delete(type);
  }
  create(config, dependencies) {
    const factory = this.#factories.get(config.type);
    return factory ? factory(config, dependencies) : {
      start: async () => ({ status: 'rejected', reason: 'Adapter type not installed' }),
      reconcile: async () => ({ status: 'unknown' }), health: async () => ({ available: false })
    };
  }
}
