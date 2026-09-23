# Visual conventions — app implementation

The authenticated app uses the existing Ink & Jade material and semantic-token
system. Visual changes must work within it rather than inventing a local palette
for a new screen. The default light roles live in
[`ink-jade.css`](../../../packages/design-tokens/src/ink-jade.css); shipped dark
role overrides live in
[`themes.css`](../../../packages/design-tokens/src/themes.css).
The tokens, not sampled values in a design note, are the color authority.

## Three tiers

1. **Shared semantic tokens** in `@meridian/design-tokens/ink-jade.css` own
   reusable color, type, radius, spacing, and elevation roles. Components
   consume roles such as `bg-background`, `bg-card`, `text-foreground`, and
   `text-jade-text`; they do not consume private palette atoms or raw colors.
2. **App utilities** in [`globals.css`](../src/styles/globals.css) compose
   cross-component geometry and type behavior: `app-frame`, `app-scroll`,
   `main-pane`, `chat-column`, `prose-tokens`, and the text tiers. Promote a
   repeated cross-component rhythm here rather than copying a style recipe.
3. **Component-local Tailwind scale** handles internal padding, gaps, and
   component-specific geometry. Do not promote a value just because one
   component uses it.

The light shell uses one warm surface family: shelf below chrome, page as the
brightest field, and lifted cards or inputs above the page. The shelf stays
flat while its content scrolls. Jade marks actions and focus; cinnabar is a
scarce seal, not routine selection. The app library and creation form use the
same roles as the project workspace. Shell separation is tonal, not a stack of
structural borders or shadows.

Dark mode is a shipped alternate palette selected by `data-ui-theme="dark"`.
The default light palette has no theme attribute. The device-local preference
is set before paint by `src/lib/ui-theme.ts` and changed from Settings →
Preferences. Tailwind's `dark:` variant keys off the same attribute, not a
`.dark` class. Color role names remain stable across themes.

Inter is the app font for UI, headings, editor content, and rendered prose.
Code uses the monospace token. Use shared type roles and size/weight for
hierarchy; do not introduce a second app font for a feature.

## Layout and overflow

Page-level horizontal scroll is prevented at the boundaries, not by adding
`min-w-0` to every turn leaf:

1. `html`/`body` and `app-frame` keep a viewport-locked shell.
2. `app-scroll` marks the regions that may scroll vertically.
3. `main-pane` provides flex shrink and horizontal clipping on the shell
   inset, chat surface, and scroll owner.
4. `chat-column` bounds content width; `prose-tokens` wraps prose and gives
   `pre` and tables their own local scroll.
5. A truncating flex child keeps its own `min-w-0`; the user-turn bubble keeps
   its bounded width.

See [source app-shell patterns](source-app-shell-patterns.md) for the OSS
comparison behind these boundaries.

`prose-tokens` owns rendered-Markdown element styling and scales with the text
preference. `text-tier-chat` sets the conversation one preference stop below
the manuscript; `text-tier-compact` is the fixed dense-meta voice. Do not add
fixed-rem overrides that pin inner code or table cells off the text scale.

Dropdown row geometry is shared by `components/ui/dropdown-presentation.ts`.
Rows own their full-width hover, selection, and focus paint; labels and search
fields add their own gutters. Shared Radix dropdown and context-menu content
cancel non-primary `pointerup` during capture. Otherwise releasing a right
click can activate the first menu row under the pointer even though the writer
only intended to open the context menu. Keep this guard in the shared wrappers.

## Verification

Inspect touched visual files for raw colors and arbitrary spacing or type
values. A literal is either genuine component geometry or a role that belongs
in tokens or an app utility. Tests assert behavior, semantics, and accessible
states, not Tailwind class strings. Verify actual layout and touch targets in a
browser; JSDOM cannot prove geometry.
