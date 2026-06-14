# `src/locales/` — Lingui i18n

The app uses [LinguiJS](https://lingui.dev) v6 for runtime i18n. Today the
only locale is **en-US**; the infrastructure is set up so a new locale is a
drop-in change.

## Layout

```
src/locales/
├── README.md            ← you are here
└── en/
    ├── messages.po      ← source-of-truth catalog (translators edit this)
    └── messages.ts      ← compiled runtime catalog (loaded by the app)
```

Both files are committed so a fresh clone works without an extra build step.

## How extraction works

Every user-facing string in the app goes through a Lingui macro:

```tsx
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

<h1><Trans>Account details</Trans></h1>;
<button aria-label={t`Send message`}>…</button>;

// Outside of JSX, for use with `i18n._()`:
import { msg } from "@lingui/core/macro";
const greeting = msg`Welcome back`;

// ICU plural:
import { plural } from "@lingui/core/macro";
const summary = plural(count, { one: "Ran # tool", other: "Ran # tools" });
```

At build time, `@lingui/babel-plugin-lingui-macro` rewrites every macro
call site into a `MessageDescriptor` keyed by a content-hashed id (see
`vite.config.ts` for the wiring — Babel runs as a custom Vite plugin
because `@vitejs/plugin-react` v6 dropped its Babel hook).

The `lingui extract` CLI then walks `src/` for the same macro calls and
writes their ids + source strings into `messages.po`.

## Compile

`lingui compile` reads `messages.po` and emits `messages.ts`, a frozen
runtime catalog imported by `src/lib/i18n.ts`. The bundled Vite plugin
`@lingui/vite-plugin` also auto-compiles `.po → .ts` on the fly during
dev/build, so you usually only need to run `lingui:compile` manually when
committing.

```bash
pnpm --filter @meridian/app lingui:extract   # scan source → update .po
pnpm --filter @meridian/app lingui:compile   # .po → .ts (committed)
```

`lingui extract` is idempotent — running it twice doesn't churn the catalog
beyond a regenerated header timestamp.

## How to add a new locale

1. Add the locale code to `lingui.config.ts`:
   ```ts
   locales: ["en", "de"],
   ```
2. Run extract to seed the catalog file:
   ```bash
   pnpm --filter @meridian/app lingui:extract
   ```
   This creates `src/locales/de/messages.po` populated with empty
   translation slots.
3. Translate `src/locales/de/messages.po` (in-house or via your TMS).
4. Compile the runtime catalog:
   ```bash
   pnpm --filter @meridian/app lingui:compile
   ```
5. Register the catalog with the app at
   `src/lib/i18n.ts` — add it to the `CATALOGS` map:
   ```ts
   import { messages as deMessages } from "@/locales/de/messages";
   const CATALOGS = { en: enMessages, de: deMessages } as const;
   ```

That's it. **No component-site code changes** are required — every user-facing
string already routes through a Lingui macro.

## Where the locale-resolution seam lives

`src/lib/i18n.ts` exports `resolveLocale(request)`. Today it always returns
`"en"`. When you wire up multi-locale support, that is the single function to
change:

- Read a cookie / `Accept-Language` header / URL segment on the server.
- Validate against the `CATALOGS` keys.
- Fall back to `DEFAULT_LOCALE` for anything unknown.

Keep `resolveLocale` pure and synchronous so SSR + client agree on the active
locale during hydration.

## Date / number formatting

Locale-aware date / number formatting uses `Intl.*` keyed off the active
Lingui locale:

```ts
import { i18n } from "@/lib/i18n";

new Intl.DateTimeFormat(i18n.locale, { month: "short", day: "numeric" }).format(d);
```

This is the pattern documented in `src/lib/thread-groups.ts`. Phase 4 / 5
should follow it.
