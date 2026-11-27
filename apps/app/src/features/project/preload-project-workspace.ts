export function preloadProjectWorkspace(): void {
  void import("./routing/ReadableProjectRoute").catch(() => undefined);
}
