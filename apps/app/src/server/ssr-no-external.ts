/**
 * Packages that must stay bundled in Vite's SSR module runner.
 *
 * Meridian's Supabase auth path currently does not require auth-provider
 * packages to be forced into the SSR bundle. Keep this seam so provider-specific
 * bundling quirks stay out of `vite.config.ts` when they appear.
 */
export const APP_SSR_NO_EXTERNAL: (string | RegExp)[] = [];

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
