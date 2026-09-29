/** Keep Nitro's dev supervisor alive while its server worker handles SIGTERM. */
const DEV_SHUTDOWN_KEY = Symbol.for("meridian.api.nitro-dev-shutdown.v1");

type DevShutdownState = {
  installed: boolean;
  close?: () => Promise<void>;
  shutdown?: Promise<void>;
};

type DevShutdownGlobal = typeof globalThis & {
  [DEV_SHUTDOWN_KEY]?: DevShutdownState;
};

function state(): DevShutdownState {
  const store = globalThis as DevShutdownGlobal;
  let current = store[DEV_SHUTDOWN_KEY];
  if (!current) {
    current = { installed: false };
    store[DEV_SHUTDOWN_KEY] = current;
  }
  return current;
}

/**
 * Nitro dev serves from a child worker. Closing the supervisor sends that
 * worker SIGTERM; retaining its ChildProcess handle lets the worker's bounded
 * application drain finish before the supervisor exits naturally.
 */
export function installNitroDevShutdown(nitro: { close(): Promise<void> }): void {
  const current = state();
  current.close = () => nitro.close();
  if (current.installed) return;
  current.installed = true;

  const shutdown = () => {
    current.shutdown ??= Promise.resolve()
      .then(() => current.close?.())
      .then(
        () => undefined,
        () => undefined,
      );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
