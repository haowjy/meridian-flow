let marsSchema: Promise<typeof import("@meridian-flow/mars-schema")> | undefined;
export const loadMars = () =>
  (marsSchema ??= import("@meridian-flow/mars-schema").then(async (mars) => {
    const init = (mars as { default?: unknown }).default;
    if (typeof init === "function") await init();
    return mars;
  }));
