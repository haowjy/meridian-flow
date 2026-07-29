/**
 * Which fenced languages the page draws instead of showing, and who draws them.
 *
 * §5.2's rule is that the page never shows a diagram's syntax. WHICH fences that
 * covers is this catalog and nothing else: the fence node view asks it whether
 * to render, object physics generates a registration per row
 * (`../objects/object-types.ts`), the object surface reads a row for the
 * writer's verbs, and the language menu offers every row by name.
 *
 * **A new diagram kind is one row plus its renderer.** The row names the fence
 * language, the name the writer's verbs use, the starter source a fresh diagram
 * opens on, and the async function that turns source into SVG. Everything else —
 * the debounce, the three faces, the source hatch, copy, export, the object row,
 * the ⋮, physics, the language menu — is already provider-neutral.
 *
 * What a renderer owes the rest of the editor:
 *
 * - **SVG markup, or a throw whose message names the problem.** The message is
 *   shown to the writer verbatim (§5.2's stale and unrendered faces), so it has
 *   to read like a parse error, not like a stack trace.
 * - **The manuscript's own ink.** A diagram drawn in a library's stock palette
 *   reads as a screenshot from another application. Read the design tokens at
 *   render time (`mermaid-theme.ts` is the worked example) rather than copying
 *   colors, so a theme switch redraws.
 * - **Sanitized output.** The markup is inserted as HTML; authored labels must
 *   not survive as markup.
 */

import type { Node as PMNode } from "@tiptap/pm/model";

import { renderMermaid } from "./mermaid-render";

export type DiagramProvider = {
  /** The `code_block` language attr that makes a fence this kind of diagram. */
  language: string;
  /**
   * The provider's own name, as the writer's verbs spell it ("Copy Mermaid
   * source"). Not localized: it is the name of a syntax, not a word.
   */
  name: string;
  /**
   * What a brand-new diagram opens on, so the writer sees a diagram rather than
   * an empty fence (law 2's sole auto-edit). Not localized: keywords are syntax,
   * and the labels are document content the writer overwrites immediately.
   */
  starterSource: string;
  /** Source in, SVG markup out. `id` is written into the markup, so it is unique per consumer. */
  render: (id: string, source: string) => Promise<string>;
};

export const EDITOR_DIAGRAM_PROVIDERS: readonly DiagramProvider[] = [
  {
    language: "mermaid",
    name: "Mermaid",
    starterSource: "flowchart TD\n  A[Start] --> B[Next]",
    render: renderMermaid,
  },
  // ── a new diagram kind is one row here, plus the renderer it names ──
];

/**
 * The provider a fence in `language` belongs to, or null for a fence the writer
 * types in. An empty or unknown language is a plain fence, which is the common
 * case and not an error.
 */
export function diagramProviderForLanguage(language: unknown): DiagramProvider | null {
  if (typeof language !== "string" || language === "") return null;
  return EDITOR_DIAGRAM_PROVIDERS.find((provider) => provider.language === language) ?? null;
}

/** The provider this node's fence belongs to, or null for prose and plain code. */
export function diagramProviderFor(node: PMNode): DiagramProvider | null {
  return diagramProviderForLanguage(node.attrs.language);
}

/**
 * What `/` inserts and what a fresh diagram opens on: the first row.
 *
 * Order is the catalog's answer to "which one is THE diagram" — a writer asking
 * for a diagram means the one this product draws by default, and reaches the
 * others through the fence's language menu.
 */
export function defaultDiagramProvider(): DiagramProvider {
  const first = EDITOR_DIAGRAM_PROVIDERS[0];
  if (!first) throw new Error("no diagram provider is registered");
  return first;
}
