/** Parent loaders acquire shell identity; child navigation must not reacquire it. */
export const PERSISTENT_SHELL_OPTIONS = {
  // Explicit router.invalidate() still revalidates. This only suppresses incidental
  // same-href/history-state reloads while the account/project shell remains mounted.
  shouldReload: ({ cause }: { cause: "preload" | "enter" | "stay" }) => cause !== "stay",
};
