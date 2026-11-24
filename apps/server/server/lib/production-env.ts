export function isProductionEnv(input: { rawNodeEnv?: string; rawAppEnv?: string }): boolean {
  const appEnv = input.rawAppEnv ?? "dev";
  return appEnv === "production" || (input.rawNodeEnv === "production" && appEnv === "dev");
}
