// Keep AuthKit packages bundled in dev SSR; externalizing loses named exports
export const APP_SSR_NO_EXTERNAL: (string | RegExp)[] = [
  "@workos/authkit-tanstack-react-start",
  "@workos/authkit-session",
];
