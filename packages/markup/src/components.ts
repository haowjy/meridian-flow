/** MDX component registry contracts used when parsing JSX nodes. */

/** Editor rendering hints (NodeView, toolbar items) — product-specific shape. */
export type EditorSpec = Record<string, unknown>;

export interface PropSpec {
  type: "string" | "number" | "boolean" | "null" | "array" | "object";
  required?: boolean;
  default?: unknown;
}

export interface ComponentSpec {
  /** Component name as it appears in MDX source. */
  name: string;

  /** Which PM node type to use. */
  kind: "leaf" | "container";

  /** Allowed props — validated on parse/apply, not in PM schema. */
  props: Record<string, PropSpec>;

  /** Child content model. */
  children: "none" | "inline" | "block";

  /** Editor rendering hints (NodeView, toolbar items). */
  editor?: EditorSpec;
}

/** Product configuration map: component name → spec. */
export type ComponentRegistry = Readonly<Record<string, ComponentSpec>>;

/** Reserved wire components handled by dedicated codecs rather than generic JSX nodes. */
export const builtInComponents = {
  Figure: {
    name: "Figure",
    kind: "leaf",
    children: "none",
    props: {
      src: { type: "string" },
      alt: { type: "string" },
      label: { type: "string" },
      caption: { type: "string" },
    },
  },
  Layout: {
    name: "Layout",
    kind: "container",
    children: "block",
    props: {
      align: { type: "string" },
      widths: { type: "string" },
    },
  },
} as const satisfies ComponentRegistry;

/**
 * Product document components consumed by every document codec and renderer.
 * Reserved wire components remain in `builtInComponents`; add generic product
 * components here so they enter every surface through one composition seam.
 */
export const documentComponentRegistry = {
  ...builtInComponents,
} as const satisfies ComponentRegistry;
