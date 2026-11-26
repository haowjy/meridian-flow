export type EditorSpec = Record<string, unknown>;

export interface PropSpec {
  type: "string" | "number" | "boolean" | "null" | "array" | "object";
  required?: boolean;
  default?: unknown;
}

export interface ComponentSpec {
  name: string;

  kind: "leaf" | "container";

  props: Record<string, PropSpec>;

  children: "none" | "inline" | "block";

  editor?: EditorSpec;
}

export type ComponentRegistry = Readonly<Record<string, ComponentSpec>>;

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

export const documentComponentRegistry = {
  ...builtInComponents,
} as const satisfies ComponentRegistry;
