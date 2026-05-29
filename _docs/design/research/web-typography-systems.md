# Web typography systems for reading + UI apps

Executive summary
-----------------

- For apps that mix long-form reading/writing with dense chrome, the best-supported pattern is a **role-based type system**: one family for prose, one for UI, and one for code/technical literals. The main win is semantic clarity; the main risk is overusing typefaces or choosing families that are too similar to each other.
- Your current spec — **Geist UI / iA Writer Quattro prose / Geist Mono**, an **8-step fluid scale**, **3–4 visible weights per family**, and **≤4 sizes per screen** — is broadly consistent with current guidance from Apple, Material, IBM, web.dev, MDN, and iA.
- The biggest caveat is **fluid `clamp()` typography and zoom accessibility**: viewport-driven text can suppress user font preferences and break WCAG 1.4.4 if the max/min range is too aggressive. Use `rem`/`em`-based bounds, keep the range conservative, and test at 200% zoom.
- Quattro’s design rationale aligns well with prose-heavy surfaces: iA intentionally kept **large word spacing** and **monospaced punctuation** and unified Mono/Duo/Quattro under one visual family. That is a good fit for calm, sustained reading.
- Variable fonts are still a good default for systems with multiple weights/styles: they reduce file count and can improve performance, but they do not remove the need for weight discipline.

Sourced findings
----------------

### 1) Multi-font role systems: when they help, when they hurt

The strongest support for a multi-font system is **role separation**, not decorative variety.

- Apple’s typography guidance says to **minimize the number of typefaces** in an interface and warns that too many faces can obscure hierarchy and hurt readability. It also recommends avoiding very light weights in small text. [Apple Developer Typography, accessed 2026-05-29](https://developer.apple.com/design/human-interface-guidelines/typography)
- IxDF’s current font-pairing guidance says pairing works best when there is **clear contrast** in weight, width, style, or size; it also explicitly warns against using too many variations or styles in one composition. [IxDF, *How to Pair Fonts: A Practical Guide*, accessed 2026-05-29](https://www.interaction-design.org/literature/article/how-to-pair-fonts-a-practical-guide)
- iA itself ships **three purpose-built writing fonts** and describes them as a unified system rather than unrelated choices. That is a good example of “multi-font by role,” not “multi-font by taste.” [iA, *A Typographic Christmas*, 2018-12-14](https://ia.net/topics/a-typographic-christmas)

**Interpretation:** multi-font systems help when the roles are materially different:

- **Prose** needs sustained reading rhythm.
- **UI chrome** needs compact labels, navigation, metadata, and controls.
- **Mono/technical content** needs literal fidelity for code, paths, and command arguments.

They hurt when the families are too similar, because the system gains complexity without adding semantic contrast. In practice, the “best” multi-font system is often fewer fonts, used more deliberately.

### 2) iA Writer Quattro: rationale for long-form reading

iA’s own explanation for Quattro is highly relevant to a writing app:

- Quattro is described as sharing similarities with a proportional typeface while retaining “technical virtues” of typewriter fonts through **wider word spacing** and **more room per letter** than a classic proportional face. [iA, 2018-12-14](https://ia.net/topics/a-typographic-christmas)
- iA says it kept **large word spacing** and **monospaced punctuation**, and that Quattro **saves space on small screens** while producing a cleaner, more regular text image. [iA, 2018-12-14](https://ia.net/topics/a-typographic-christmas)
- Readability research still treats **x-height** as a meaningful legibility variable. Readability Matters’ 2025 research summary, based on a 2024 conference study, reports that increasing x-height improved letter recognition across the alphabet and could improve reading performance. [Readability Matters, 2025-03-27](https://readabilitymatters.org/articles/research-highlight-how-important-is-x-height-for-font-legibility)

**Interpretation:** Quattro is a good prose choice because it splits the difference between:

- a fully monospaced typewriter voice,
- and a fully proportional UI face.

That makes it especially plausible for long-form reading/writing surfaces where you want steady rhythm, but not the visual rigidity or space cost of a literal mono font.

### 3) Fluid scales with `clamp()`: consensus and accessibility

Current guidance still favors fluid typography, but with **guardrails**.

- web.dev’s 2025 article on fluid type says typography should respond to both viewport size and user input, but warns that the more text responds to the viewport, the less it responds to user preferences. It explicitly ties this to **WCAG 1.4.4 Resize Text** and says viewport-only font sizing is dangerous. [web.dev, *Responsive and fluid typography with Baseline CSS features*, published 2025-12-16](https://web.dev/articles/baseline-in-action-fluid-type)
- That same article says using `clamp()` can bound the range so text remains zoomable, and notes an important rule of thumb: if the maximum font size is no more than **2.5×** the minimum, text should still satisfy 200% resize behavior in modern browsers. It also recommends using **`em` or `rem`**, not `px`, for the min/max values. [web.dev, 2025-12-16](https://web.dev/articles/baseline-in-action-fluid-type)
- Utopia’s original `clamp()` guidance is more cautious: `clamp()` is useful for broadly fluid typography, but it warns that browser text zoom can be affected and says the results need thorough testing. [Utopia, *Clamp*, first published 2020-09-25](https://utopia.fyi/blog/clamp/)
- W3C’s WCAG 2.2 understanding doc for **Resize Text** states that text must be resizable to **200%** without loss of content or functionality, and notes common failure modes like clipping, overlap, and single-word vertical columns. [W3C WAI, WCAG 2.2 SC 1.4.4, current living doc; accessed 2026-05-29](https://w3c.github.io/wcag/understanding/resize-text.html)

**Interpretation:** `clamp()` is fine, but only if it is used as a **constrained fluid system**, not as a way to hard-cap text sizes. The critical accessibility rule is: **don’t let viewport units overpower user zoom or user font preferences**.

### 4) Type-scale and weight discipline

The major systems all converge on the same idea: **fewer, better-related type styles**.

- Material Design says a typographic scale has a **limited set** of sizes that work well together, and warns that too many sizes and styles can wreck a layout. It also says many products do not need the full default set of styles. [Android Developers / Material 3, current docs; accessed 2026-05-29](https://developer.android.com/develop/ui/compose/designsystems/material3)
- The older Material typography guidance makes the same point: “too many type sizes and styles at once can wreck any layout.” It presents a small core scale for English-like scripts and recommends dynamic type instead of relying on tiny sizes. [Material Typography guidance, accessed 2026-05-29](https://www.mdui.org/en/design/1/style/typography.html)
- IBM says its type scale is fundamental for consistency and visual coherence, and that line height and spacing should be harmonized across sizes. IBM also emphasizes that type should be simple, aligned, and readable, and explicitly includes “scale with one weight” among its core ideas. [IBM Design Language, last updated 2026-05-27](https://www.ibm.com/design/language/typography/type-scale/) and [IBM Type Basics, last updated 2026-05-27](https://www.ibm.com/design/language/typography/type-basics/)
- Apple recommends Regular, Medium, Semibold, or Bold for system-provided fonts and avoiding light weights, especially at small sizes. [Apple Developer Typography, accessed 2026-05-29](https://developer.apple.com/design/human-interface-guidelines/typography)

**Interpretation:** a practical UI usually does best with **3–4 visible weights per family** and a small set of sizes per surface. More than that rarely improves comprehension; it usually just creates noise.

### 5) Variable fonts: performance and consistency

Variable fonts are still a strong foundation for modern systems.

- MDN explains that variable fonts package many widths/weights/styles into **one file** instead of many separate files. [MDN Variable Fonts, current docs; accessed 2026-05-29](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Fonts/Variable_fonts)
- web.dev says if you use lots of weights or styles, a variable font can yield a **performance gain** because one file can replace many. It also notes that some system fonts are already variable, so you may get benefits without shipping extra files. [web.dev Typography, current docs; accessed 2026-05-29](https://web.dev/learn/design/typography)
- MDN also highlights a useful nuance: the `grade` axis can change perceived weight **without changing layout width**, which is useful when you want emphasis without reflow. [MDN Variable Fonts, accessed 2026-05-29](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Fonts/Variable_fonts)

**Interpretation:** variable fonts are a good fit for Meridian because they support:

- consistent hierarchy,
- fewer font requests,
- and finer control over weight without exploding the font inventory.

Agree / disagree with the current spec
---------------------------------------

### Spec item: 3 fonts by role

**Agree.** This is the right abstraction for a writing app. It matches what current guidance rewards: role clarity, hierarchy, and restraint. The only caveat is to keep the families visually distinct enough that each role earns its place.

### Spec item: Geist UI / iA Writer Quattro prose / Geist Mono

**Agree, with one nuance.** This is a strong role split:

- **Geist UI** for chrome and controls,
- **Quattro** for sustained prose,
- **Geist Mono** for literal technical content.

That’s a healthy separation of concerns. It also mirrors how iA thinks about writing tools: reduce noise, keep the writing surface distinct, and make code-like content visually explicit.

### Spec item: 8-size clamp() scale

**Mostly agree.** An 8-step scale is fine as a **design-token vocabulary**, but not as a default menu of visible choices on every screen. The current evidence from Material/IBM/Apple suggests that most interfaces should expose a much smaller subset in any given view.

Recommendation: keep the 8 sizes globally, but enforce **screen-level restraint**:

- prose/editor surface: usually 2–3 sizes plus headings,
- chrome-heavy surfaces: usually 3–4 sizes max,
- dialogs/menus: often 2–3 sizes.

### Spec item: 3–4 weights per font

**Agree.** This is aligned with Apple’s caution against light weights, Material’s limited-scale philosophy, and the practical benefits of variable fonts. It’s enough to express hierarchy without making the UI feel noisy.

### Spec item: ≤4 sizes per screen

**Strongly agree.** This is the clearest “discipline” rule in the spec, and it is well supported by the external evidence. Most typographic systems work best when the screen has a small number of related sizes and the hierarchy is carried primarily by size/weight/spacing, not by endless variation.

### Specific caveat: `clamp()` + zoom accessibility

**Must keep.** This is the biggest risk area in the spec.

If the system uses viewport-relative middle values, but the min/max range is too wide or the unit choices are wrong, browser zoom becomes ineffective and you can fail WCAG 1.4.4. The safe pattern is:

1. base the scale on `rem`/`em`,
2. keep viewport influence modest,
3. bound the range conservatively,
4. verify behavior at 200% zoom and text-only resize,
5. avoid letting large screens flatten user control.

Sources
-------

- [web.dev — Responsive and fluid typography with Baseline CSS features](https://web.dev/articles/baseline-in-action-fluid-type) — published 2025-12-16
- [Utopia — Clamp](https://utopia.fyi/blog/clamp/) — first published 2020-09-25
- [W3C WAI — Understanding SC 1.4.4 Resize Text](https://w3c.github.io/wcag/understanding/resize-text.html) — current living doc, accessed 2026-05-29
- [MDN — Variable fonts](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Fonts/Variable_fonts) — current docs, accessed 2026-05-29
- [web.dev — Typography](https://web.dev/learn/design/typography) — current docs, accessed 2026-05-29
- [Android Developers — Material Design 3 in Compose](https://developer.android.com/develop/ui/compose/designsystems/material3) — current docs, accessed 2026-05-29
- [IBM Design Language — Type scale](https://www.ibm.com/design/language/typography/type-scale/) — last updated 2026-05-27
- [IBM Design Language — Type basics](https://www.ibm.com/design/language/typography/type-basics/) — last updated 2026-05-27
- [iA — A Typographic Christmas](https://ia.net/topics/a-typographic-christmas) — 2018-12-14
- [Readability Matters — How important is x-height for font legibility?](https://readabilitymatters.org/articles/research-highlight-how-important-is-x-height-for-font-legibility) — 2025-03-27
- [IxDF — How to Pair Fonts: A Practical Guide](https://www.interaction-design.org/literature/article/how-to-pair-fonts-a-practical-guide) — current article, accessed 2026-05-29
- [Apple Developer — Typography](https://developer.apple.com/design/human-interface-guidelines/typography) — current docs, accessed 2026-05-29
