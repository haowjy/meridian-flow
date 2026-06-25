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

/** Product configuration map: component name → spec. Figure is not registered here. */
export type ComponentRegistry = Readonly<Record<string, ComponentSpec>>;
