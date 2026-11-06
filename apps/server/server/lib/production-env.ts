/**
 * The production rule shared by the debug-path gate and the gateway. Pure, so the gateway
 * needn't read the environment itself.
 *
 * Production as every environment gate sees it: `APP_ENV=production`, or
 * `NODE_ENV=production` with `APP_ENV` unset or `dev`, so a deployed process
 * missing `APP_ENV` fails closed. Staging is not production.
 */
export function isProductionEnv(input: { rawNodeEnv?: string; rawAppEnv?: string }): boolean {
  const appEnv = input.rawAppEnv ?? "dev";
  return appEnv === "production" || (input.rawNodeEnv === "production" && appEnv === "dev");
}
