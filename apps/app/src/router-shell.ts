export const PERSISTENT_SHELL_OPTIONS = {
  shouldReload: ({ cause }: { cause: "preload" | "enter" | "stay" }) => cause !== "stay",
};
