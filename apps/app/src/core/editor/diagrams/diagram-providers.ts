import type { Node as PMNode } from "@tiptap/pm/model";

import { renderMermaid } from "./mermaid-render";

export type DiagramProvider = {
  language: string;
  name: string;
  starterSource: string;
  render: (id: string, source: string) => Promise<string>;
};

export const EDITOR_DIAGRAM_PROVIDERS: readonly DiagramProvider[] = [
  {
    language: "mermaid",
    name: "Mermaid",
    starterSource: "flowchart TD\n  A[Start] --> B[Next]",
    render: renderMermaid,
  },
];

export function diagramProviderForLanguage(language: unknown): DiagramProvider | null {
  if (typeof language !== "string" || language === "") return null;
  return EDITOR_DIAGRAM_PROVIDERS.find((provider) => provider.language === language) ?? null;
}

export function diagramProviderFor(node: PMNode): DiagramProvider | null {
  return diagramProviderForLanguage(node.attrs.language);
}

export function defaultDiagramProvider(): DiagramProvider {
  const first = EDITOR_DIAGRAM_PROVIDERS[0];
  if (!first) throw new Error("no diagram provider is registered");
  return first;
}
