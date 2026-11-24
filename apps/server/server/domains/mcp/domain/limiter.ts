export function createLimiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };

  async function acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (running < max) {
      running += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        signal.removeEventListener("abort", leave);
        resolve();
      };
      const leave = () => {
        waiting.splice(waiting.indexOf(turn), 1);
        reject(signal.reason);
      };
      waiting.push(turn);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  return {
    get idle() {
      return running === 0 && waiting.length === 0;
    },
    async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
      await acquire(signal);
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

export type Limiter = ReturnType<typeof createLimiter>;
