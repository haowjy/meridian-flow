import { type Content, Editor, type Extensions } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

import {
  type CreateEditorExtensionsOptions,
  createStandaloneEditorExtensions,
} from "@/core/editor/config";

import { installJsdomLayoutFallbacks } from "./jsdom-layout";

export type StandaloneEditorOptions = Pick<
  CreateEditorExtensionsOptions,
  "schemaType" | "assetRenderContext" | "slashCommands"
> & {
  content?: Content;
  extensions?: Extensions;
};

export type StandaloneEditor = {
  editor: Editor;
  destroy: () => void;
};

export function createStandaloneEditor({
  content,
  extensions = [],
  ...schema
}: StandaloneEditorOptions = {}): StandaloneEditor {
  installJsdomLayoutFallbacks();
  const element = document.createElement("div");
  const pane = createManuscriptPane();
  pane.append(element);
  document.body.append(pane);
  const editor = new Editor({
    element,
    extensions: [...createStandaloneEditorExtensions(schema), ...extensions],
    content,
  });
  return {
    editor,
    destroy: () => {
      editor.destroy();
      pane.remove();
    },
  };
}

export function createManuscriptPane(): HTMLElement {
  const pane = document.createElement("div");
  pane.setAttribute("data-stable-layout-scroll", "");
  pane.style.position = "relative";
  pane.style.overflowY = "auto";
  pane.style.overflowX = "hidden";
  return pane;
}

export type NodeMatch = string | { type?: string; startsWith?: string };

function findNode(editor: Editor, match: NodeMatch): { pos: number; node: PMNode } | null {
  const { type, startsWith } = typeof match === "string" ? { type: match } : match;
  let found: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (type && node.type.name !== type) return true;
    if (startsWith && !node.textContent.startsWith(startsWith)) return true;
    found = { pos, node };
    return false;
  });
  return found;
}

export function requireNode(editor: Editor, match: NodeMatch): { pos: number; node: PMNode } {
  const found = findNode(editor, match);
  if (!found) throw new Error(`no ${JSON.stringify(match)} in the document`);
  return found;
}
