/**
 * Packages that must stay bundled in Vite's SSR module runner.
 *
 * WorkOS AuthKit packages can lose named exports when externalized in dev SSR.
 */
export const APP_SSR_NO_EXTERNAL: (string | RegExp)[] = [
  "@workos/authkit-tanstack-react-start",
  "@workos/authkit-session",
];

/**
 * Packages that must be externalized from the SSR bundle even when a package is
 * bundled via noExternal.
 *
 * Shiki ships WASM/engine packages that Rolldown's SSR WASM fallback cannot load
 * during the SSR build. Streamdown lazy-loads Shiki code-block rendering for the
 * browser, so keeping these packages external avoids SSR build failures without
 * changing runtime rendering.
 */
export const APP_SSR_EXTERNAL: string[] = [
  "shiki",
  "@shikijs/engine-oniguruma",
  "@shikijs/engine-javascript",
  "@shikijs/core",
  "@shikijs/types",
  "@shikijs/langs",
  "@shikijs/themes",
];
