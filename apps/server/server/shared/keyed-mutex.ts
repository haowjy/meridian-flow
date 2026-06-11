export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    let guard: Promise<unknown>;
    const cleanup = () => {
      if (this.chains.get(key) === guard) {
        this.chains.delete(key);
      }
    };
    guard = run.then(cleanup, cleanup);
    this.chains.set(key, guard);
    return run;
  }
}
