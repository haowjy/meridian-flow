/** Close Nitro's dev supervisor so its server worker can drain and exit. */
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
 * Nitro dev serves from a worker thread. Closing the supervisor asks the
 * worker's Nitro runtime to close; the patched runner awaits that close before
 * terminating the worker.
 */
export function installNitroDevShutdown(nitro: { close(): Promise<void> }): void {
  const current = state();
  current.close = () => nitro.close();
  if (current.installed) return;
  current.installed = true;

  const shutdown = () => {
    current.shutdown ??= Promise.resolve()
      .then(() => current.close?.())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
