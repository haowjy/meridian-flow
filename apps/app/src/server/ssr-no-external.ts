/**
 * Packages that must stay bundled in Vite's SSR module runner.
 *
 * WorkOS AuthKit packages can lose named exports when externalized in dev SSR.
 */
export const APP_SSR_NO_EXTERNAL: (string | RegExp)[] = [
  "@workos/authkit-tanstack-react-start",
  "@workos/authkit-session",
];
