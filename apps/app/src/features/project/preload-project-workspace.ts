/** Warm project workspace code without running project loaders before navigation. */
export function preloadProjectWorkspace(): void {
  void import("./routing/ReadableProjectRoute").catch(() => undefined);
}
