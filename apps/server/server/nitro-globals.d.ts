/** Ambient Nitro globals for auto-imported server plugin helpers. */
declare function defineNitroPlugin<TPlugin extends (...args: unknown[]) => unknown>(
  plugin: TPlugin,
): TPlugin;
