# Research: Enforcing component consistency in a React + Tailwind + shadcn/ui design system

Sources were checked on **2026-05-29** unless a source page exposed its own publication date.

## Executive summary

The current direction in our spec — **design tokens + variant factories (CVA/TV) + shared rule tables + shadcn `data-slot` hooks + Storybook-first development** — is broadly aligned with how modern design systems are being enforced in 2024–2026.

The strongest evidence is:

- **Design tokens are now treated as an interoperability layer, not just a naming convention.** The DTCG says its format exists to exchange tokens between tools, and the current stable line (v2025.10) supports groups, aliases, and multi-context resolution. The spec does **not** require a primitive→semantic hierarchy, but it does support the pattern cleanly. Tailwind v4’s `@theme` directive reinforces the idea of tokens as utility-generating source-of-truth values, while `:root` remains the place for CSS variables that should *not* become utilities. [DTCG FAQ, stable v2025.10; Tailwind CSS docs, 2024–2026](https://www.designtokens.org/faq/) / [Tailwind theme variables](https://tailwindcss.com/docs/theme)
- **Variant management works best when it is centralized and bounded.** CVA’s model is base classes + named variants + compound variants + defaults. `tailwind-merge` is best used as the boundary layer for merging component defaults with consumer overrides, not as a blanket “let anything override anything” mechanism. `tailwind-variants` adds first-class slots and built-in conflict resolution, which can be useful for multi-part components, but it also expands the abstraction surface. [CVA README](https://github.com/joe-bell/cva), [tailwind-merge docs](https://github.com/dcastil/tailwind-merge/blob/main/docs/when-and-how-to-use-it.md), [tailwind-variants README](https://github.com/heroui-inc/tailwind-variants)
- **shadcn/ui is intentionally not a traditional versioned component library.** It is “open code” plus a flat-file registry/CLI distribution model, and the docs explicitly emphasize copying code into your project, editing it locally, and using `data-slot` hooks for styling. That makes it extremely flexible and AI-friendly, but it also means *your* repo must provide the enforcement that a versioned library like MUI or Radix Themes would otherwise centralize. [shadcn introduction](https://ui.shadcn.com/docs), [shadcn registry](https://ui.shadcn.com/docs/registry), [shadcn Tailwind v4 / data-slot](https://ui.shadcn.com/docs/tailwind-v4), [MUI theming](https://mui.com/material-ui/customization/theming/), [Radix Themes styling](https://www.radix-ui.com/themes/docs/overview/styling)
- **The practical enforcement stack is lint + docs + visual tests.** ESLint should be run at `error` in CI for the consistency rules you care about. Stylelint can enforce custom-property naming and CSS conventions. Tailwind-specific lint plugins can ban arbitrary values or custom classnames. Chromatic can be made a mandatory PR check so visual changes cannot merge without review. Storybook remains the best “component contract” surface because each story captures a component state and can be used as a testing spec.

Bottom line: our spec is already on the right track. The main thing we are missing is **explicit enforcement policy**: what is allowed to vary, what is forbidden, which checks gate merges, and which layer owns each concern.

---

## Sourced findings

### 1) Design tokens as the single source of truth

#### What the current standard says

The Design Tokens Community Group (DTCG) describes its format as a way to exchange design tokens between tools and says the format unlocks interoperability and theming across tools, codebases, and platforms. The FAQ says the spec’s first stable version is **v2025.10** and that it is safe for production use, though still evolving. [DTCG home](https://www.designtokens.org/), [DTCG FAQ](https://www.designtokens.org/faq/)

The current format/resolver documentation is important for layering:

- **Groups** exist for hierarchy, but the spec says groups are arbitrary and tools should not infer type or purpose from them. [Format module](https://www.designtokens.org/tr/drafts/format/)
- **Aliases/references** are first-class: a token may reference another token, and aliases are explicitly useful for semantic relationships, DRYing values, and consistency. [Format module](https://www.designtokens.org/tr/drafts/format/)
- **Multi-context resolution** exists in the resolver module: the spec handles tokens across contexts like light/dark themes, and later sets/modifiers override earlier ones in resolution order. [Resolver module](https://www.designtokens.org/tr/drafts/resolver/)

#### What this means for token layering

The evidence suggests a fairly clear consensus:

- **Primitive tokens** should hold raw values.
- **Semantic tokens** should alias primitives and express intent.
- **Contextual tokens / modifiers** should handle mode- or state-specific overrides.
- **Groups are organizational, not semantic.**

That said, the DTCG does **not** mandate a primitive→semantic two-layer architecture. That layering is an implementation convention, not a spec requirement. The standard gives you the mechanics (groups, aliases, resolution order), and teams are converging on the layered model because it is easier to govern.

#### Tailwind v4’s token model

Tailwind v4 formalizes tokens as theme variables under `@theme`. Its docs are explicit: use `@theme` when a token should map directly to a utility class, and use `:root` for plain CSS variables that should not create utilities. That is a strong enforcement mechanism because it couples the token definition to generated utilities instead of allowing ad hoc utility drift. [Tailwind theme variables](https://tailwindcss.com/docs/theme)

shadcn/ui’s Tailwind v4 docs also show the migration pattern we want to preserve: CSS variables live in `:root`, then are referenced from `@theme` and fed into utilities. [shadcn Tailwind v4](https://ui.shadcn.com/docs/tailwind-v4)

#### Recommendation from the evidence

Keep the two-layer model:

1. **Primitives**: base palette, spacing scale, radius scale, typography scale.
2. **Semantic tokens**: background, foreground, accent, destructive, etc. as aliases.
3. **Component-level tokens** only when there is a real recurring need and a stable contract.

Do **not** rely on group names as a semantic source of truth. The spec explicitly warns against that.

---

### 2) Variant management: CVA, tailwind-merge, and tailwind-variants

#### CVA’s enforcement model

CVA is designed around a narrow abstraction: define base classes, named variants, compound variants, and defaults. That keeps the variant surface explicit and searchable. It also keeps the “what styles exist?” question inside a single variant definition instead of scattering one-off Tailwind strings through JSX. [CVA README](https://github.com/joe-bell/cva)

That structure is valuable for design-system enforcement because it makes the supported API visible. Anything outside the variant map is, by definition, an escape hatch.

#### tailwind-merge’s role

The tailwind-merge docs are very clear that it should be treated as an **escape hatch**, not the primary styling abstraction. Its primary purpose is to merge a component’s default classes with a `className` prop. The docs also warn that if you let arbitrary overrides flow everywhere, you increase freedom in ways that can make refactoring harder. For internal class composition, they recommend `twJoin` when no conflict resolution is needed. [tailwind-merge docs](https://github.com/dcastil/tailwind-merge/blob/main/docs/when-and-how-to-use-it.md)

This is an important enforcement signal: use `twMerge` at component boundaries, not as a license for unlimited ad hoc styling.

#### tailwind-variants

`tailwind-variants` takes a more feature-rich approach: first-class variant API, slots support, composition support, and automatic conflict resolution. The repo also recommends `tailwind-merge` for automatic conflict resolution and offers a `/lite` entry for cases where you want to skip conflict resolution and reduce bundle/runtime cost. [tailwind-variants README](https://github.com/heroui-inc/tailwind-variants)

#### What teams do in practice to prevent variant sprawl

The sources point to a common discipline rather than a single library choice:

- Put all supported styling states in one variant factory.
- Use `compoundVariants` for combinations that are truly special.
- Keep `className` as a limited override surface.
- Avoid inventing new props for every one-off style; that is how sprawl starts.
- Prefer `twJoin`/plain concatenation internally and `twMerge` only when merging user input or downstream overrides.

#### Recommendation from the evidence

For our system:

- **CVA + tailwind-merge** is a very good default for atoms and simple composites.
- **tailwind-variants** is attractive for multi-slot components where slot-specific styling would otherwise become repetitive.
- Whichever we choose, we should standardize on **one canonical variant pattern** and forbid ad hoc styling outside the pattern except via documented escape hatches.

My recommendation is to keep **CVA + tailwind-merge** as the default for the design system core, and only introduce `tailwind-variants` if slot-heavy composites start creating enough repeated glue code that the extra abstraction pays for itself.

---

### 3) shadcn/ui philosophy and how it differs from versioned component libraries

#### shadcn/ui’s model

shadcn/ui is explicit: it is “not a component library,” it is a way to build your component library. The docs emphasize open code, predictable composition, flat-file distribution, and AI-readability. The registry/CLI model lets you copy components into the project and own the code locally. [shadcn introduction](https://ui.shadcn.com/docs), [shadcn registry](https://ui.shadcn.com/docs/registry), [shadcn CLI](https://ui.shadcn.com/docs/cli)

The v4 docs add an important enforcement detail: every primitive now has a `data-slot` attribute for styling. That gives you a stable selector hook that is more robust than relying on generated class names or brittle DOM structure. [shadcn Tailwind v4](https://ui.shadcn.com/docs/tailwind-v4)

#### How that affects consistency

shadcn’s strengths:

- You can align the component code exactly with your design system.
- You can change internals without waiting on upstream releases.
- You can make component usage more predictable for agents because the code is local and readable.

shadcn’s downside versus a versioned library:

- It does **not** centralize consistency for you.
- If your repo allows one-off styling or divergent patterns, those divergences will accumulate quickly.
- The “library” boundary is intentionally thin, so governance has to come from your own tokens, lint rules, stories, and tests.

#### Comparison to Radix Themes and MUI

Versioned libraries like Radix Themes and MUI centralize more of the consistency contract:

- Radix Themes has a `Theme` component and tokenized theme surface; it explicitly warns that portals outside the theme root lose access to theme tokens unless wrapped again. [Radix Themes styling](https://www.radix-ui.com/themes/docs/overview/styling)
- Radix Themes also remaps color tokens in place, which is a strong built-in consistency mechanism. [Radix Themes color](https://www.radix-ui.com/themes/docs/theme/color)
- MUI uses `ThemeProvider` and theme configuration variables to promote consistency across apps. [MUI theming](https://mui.com/material-ui/customization/theming/)

So the tradeoff is:

- **shadcn/ui**: more local control, less upstream rigidity, more need for repo-level enforcement.
- **Radix Themes / MUI**: more package-level consistency, more opinionated API surface, less freedom to reshape internals.

#### Recommendation from the evidence

Our current shadcn-style approach is consistent with modern practice, but only if we add stronger governance around:

- token consumption,
- allowed variant surfaces,
- `data-slot` usage,
- Storybook coverage,
- and visual regression gating.

---

### 4) Linting and automation that enforce consistency

#### ESLint

ESLint docs are explicit that rules are typically set to `error` in CI, pre-commit, and pull-request merging because that makes ESLint exit non-zero. That is the basic enforcement lever for code-level consistency rules. [ESLint rules config](https://eslint.org/docs/latest/use/configure/rules)

For Tailwind-heavy codebases, the ecosystem’s lint plugins add useful consistency checks. The `eslint-plugin-tailwindcss` package documents rules such as `no-custom-classname` and `no-arbitrary-value`, which are exactly the kinds of checks that stop one-off styles from creeping in. [eslint-plugin-tailwindcss npm docs](https://www.npmjs.com/package/eslint-plugin-tailwindcss)

#### Stylelint

Stylelint’s own docs describe enforcement for conventions such as naming patterns for custom properties and disallowing specific units or notations. That makes it the right tool for CSS-level token discipline, especially if any of the system still uses authored CSS alongside Tailwind. [Stylelint home](https://stylelint.io/index.html)

#### Design-side linting

There are also Figma-side lint tools such as Design Lint / similar plugins, which can help catch token mismatches and deviations before code is written. These tools are useful as a **pre-code feedback layer**, but they are not substitutes for repo-level enforcement because they do not gate the actual merge.

My read: treat design linting as a supplemental guardrail, not the source of truth.

#### Visual regression as a gate

Chromatic’s docs make the gating model explicit:

- Chromatic provides status checks on pull requests.
- If visual changes are detected, the check remains pending until reviewed.
- You can require those checks in branch protection rules so the PR cannot merge until approved. [Chromatic mandatory PR checks](https://docs.chromatic.com/docs/mandatory-pr-checks/)

That is one of the strongest enforcement mechanisms available for UI consistency because it catches what static analysis cannot: actual rendering differences.

#### Recommendation from the evidence

A serious consistency stack should include:

1. **ESLint errors** for invalid styling patterns.
2. **Stylelint** for CSS/token conventions.
3. **Tailwind-specific lint rules** to ban arbitrary values and custom classnames except in approved cases.
4. **Chromatic mandatory PR checks** for visual regressions.
5. Optional design-side linting for earlier feedback.

---

### 5) Storybook-first / component-driven development

Storybook’s docs describe the core model well: a story captures a rendered state of a component, each component can have multiple stories, docs can be auto-generated alongside stories, and stories are a pragmatic starting point for UI testing. [Storybook docs](https://storybook.js.org/docs/)

Chromatic builds on that model by running visual, interaction, and accessibility tests over Storybook stories and by letting teams promote those checks into required PR gates. [Chromatic Storybook quickstart](https://www.chromatic.com/docs/storybook), [Chromatic mandatory PR checks](https://docs.chromatic.com/docs/mandatory-pr-checks/)

#### Why this matters for consistency

Storybook-first creates an enforcement discipline because it forces every component to have:

- a canonical rendering surface,
- named states,
- documented composition,
- and a place for visual/test review.

This is especially important in a shadcn-style code-owned system, because the stories become the shared contract for how the local code is supposed to behave.

#### Recommendation from the evidence

We should treat Storybook not just as documentation, but as the **authoritative test matrix** for component states and variants. The practical rule is: if a state matters enough to be supported, it deserves a story.

---

## Where the evidence agrees with our current spec

### Strong agreement

- **Tokens-first architecture**: Yes. The evidence strongly supports using tokens as the primary consistency surface.
- **Primitive → semantic layering**: Yes, as an implementation convention. Not mandated by DTCG, but widely aligned with how the spec’s alias/resolution model is used.
- **Shared component rule tables**: Yes. Explicit variant/behavior tables are a good enforcement tool because they reduce ambiguity.
- **shadcn `data-slot` hooks**: Yes. This is directly aligned with how shadcn is positioning Tailwind v4 styling.
- **Storybook-first**: Yes. Storybook + Chromatic is one of the clearest enforcement pipelines for UI consistency.

### Partial agreement / caution

- **CVA-only for all components**: Fine for many components, but multi-slot composites may justify `tailwind-variants` or another slot-aware abstraction if repeated glue code becomes a maintenance problem.
- **Tailwind utility freedom**: Tailwind is powerful, but the evidence warns that unrestricted overrides can make refactors harder. We should keep an explicit escape-hatch policy.
- **Open code without hard gates**: shadcn’s model depends on local governance. Without lint/tests, consistency will drift.

---

## What we are missing

These are the gaps I would tighten in the spec or surrounding tooling:

1. **An explicit token policy**
   - What is allowed in primitives?
   - Which semantic tokens are canonical?
   - Are component-specific tokens allowed, and when?
   - Can tokens reference other tokens across files?

2. **An explicit override policy**
   - Where is `className` allowed?
   - When is `twMerge` allowed?
   - What counts as a supported escape hatch versus a forbidden one-off?

3. **A lint contract**
   - Ban arbitrary Tailwind values except in approved files.
   - Ban raw hex / raw color utilities outside token plumbing.
   - Require `data-slot` on all shadcn-derived primitives.
   - Require variant factories for components that expose styles.

4. **A story coverage contract**
   - Every component state needs a story.
   - Every important variant combination should have a story.
   - Stories should cover loading, empty, error, and interaction states where relevant.

5. **A visual gate**
   - Chromatic or equivalent should be required on merge.
   - Visual diffs should be reviewed before merging.

6. **A “no orphan styles” rule**
   - If a style pattern repeats more than once, it should graduate into a token, variant, or shared composite.

7. **A versioned source-of-truth for shared rules**
   - Shared rule tables are good, but they should be mechanically linked to the implementation surface so docs don’t drift.

---

## Recommended stance

If I had to condense the evidence into one sentence:

> Use **DTCG-style tokens** for the value system, **CVA/tailwind-merge** for controlled styling variants, **shadcn `data-slot`** for stable local composition, and **Storybook + Chromatic + lint rules** as the actual enforcement layer.

That combination is the best current balance of flexibility and consistency for a React + Tailwind + shadcn/ui codebase.

---

## Source notes

These are the main sources used, with dates where available:

- [Design Tokens Format Module 2025.10](https://www.designtokens.org/tr/drafts/format/) — draft page dated **07 May 2026**
- [Design Tokens Resolver Module 2025.10](https://www.designtokens.org/tr/drafts/resolver/) — draft page dated **07 May 2026**
- [Design Tokens Community Group FAQ](https://www.designtokens.org/faq/) — accessed **2026-05-29**; notes that v2025.10 is the first stable version
- [Tailwind CSS theme variables](https://tailwindcss.com/docs/theme) — accessed **2026-05-29**
- [shadcn/ui introduction](https://ui.shadcn.com/docs) — accessed **2026-05-29**
- [shadcn/ui registry docs](https://ui.shadcn.com/docs/registry) — accessed **2026-05-29**
- [shadcn/ui Tailwind v4 docs](https://ui.shadcn.com/docs/tailwind-v4) — accessed **2026-05-29**
- [CVA README](https://github.com/joe-bell/cva) — accessed **2026-05-29**
- [tailwind-merge guidance](https://github.com/dcastil/tailwind-merge/blob/main/docs/when-and-how-to-use-it.md) — accessed **2026-05-29**
- [tailwind-variants README](https://github.com/heroui-inc/tailwind-variants) — accessed **2026-05-29**
- [ESLint rules configuration](https://eslint.org/docs/latest/use/configure/rules) — accessed **2026-05-29**
- [Stylelint home](https://stylelint.io/index.html) — accessed **2026-05-29**
- [eslint-plugin-tailwindcss npm docs](https://www.npmjs.com/package/eslint-plugin-tailwindcss) — accessed **2026-05-29**
- [Storybook docs](https://storybook.js.org/docs/) — accessed **2026-05-29**
- [Chromatic mandatory PR checks](https://docs.chromatic.com/docs/mandatory-pr-checks/) — accessed **2026-05-29**
- [Chromatic Storybook docs](https://www.chromatic.com/docs/storybook) — accessed **2026-05-29**
- [MUI theming docs](https://mui.com/material-ui/customization/theming/) — accessed **2026-05-29**
- [Radix Themes styling docs](https://www.radix-ui.com/themes/docs/overview/styling) — accessed **2026-05-29**
- [Radix Themes color docs](https://www.radix-ui.com/themes/docs/theme/color) — accessed **2026-05-29**
