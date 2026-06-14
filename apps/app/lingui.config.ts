import type { LinguiConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

/**
 * Lingui catalog + extractor configuration for `@meridian/app`.
 *
 * Initial locale: en-US only. Adding more locales is a drop-in change here:
 * 1. Add the locale code to `locales` (e.g. `"de"`, `"zh-Hant"`).
 * 2. Run `pnpm --filter @meridian/app lingui:extract` to seed the catalog file.
 * 3. Translate `src/locales/<code>/messages.po`.
 * 4. Run `pnpm --filter @meridian/app lingui:compile`.
 *
 * No component-site code changes are required. See `src/locales/README.md`.
 */
const config: LinguiConfig = {
  locales: ["en", "zh"],
  sourceLocale: "en",
  catalogs: [
    {
      path: "src/locales/{locale}/messages",
      include: ["src"],
    },
  ],
  // Standard `.po` format. Line numbers are off so reordered call sites don't
  // produce noisy diffs in code review.
  format: formatter({ lineNumbers: false }),
  compileNamespace: "ts",
};

export default config;
