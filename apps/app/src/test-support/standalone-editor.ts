/**
 * One editor over its own document: the cheap tier beside `collab-editors.ts`.
 *
 * Reach for this unless a claim names a peer. A collab pair exists for one
 * hazard — y-prosemirror rebuilding the whole ProseMirror document out from
 * under a surface — and a local test that pays for it inherits the binding's
 * mount sequence, so a change to collaboration setup breaks behavior that
 * never collaborated.
 *
 * What it owns is the setup every suite had been getting slightly differently:
 * which extensions the editor runs, that its DOM is in the page, what teardown
 * removes, and where a node is. Documents stay with the test — a lane's
 * fixture is part of what it is claiming — and so does anything genuinely
 * domain-shaped, like reading a pending upload's status off a decoration.
 */

import { type Content, Editor, type Extensions } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

import {
  type CreateEditorExtensionsOptions,
  createStandaloneEditorExtensions,
} from "@/core/editor/config";

import { installJsdomLayoutFallbacks } from "./jsdom-layout";

export type StandaloneEditorOptions = Pick<
  CreateEditorExtensionsOptions,
  "schemaType" | "assetRenderContext" | "slashCommands" | "wikilinks"
> & {
  content?: Content;
  /** What this lane adds on top of the canonical set — usually its own extension. */
  extensions?: Extensions;
};

export type StandaloneEditor = {
  editor: Editor;
  /** Destroys the editor and takes its manuscript back out of the page. */
  destroy: () => void;
};

/**
 * An editor whose DOM is in the page, because most of what these tests do is
 * press something: a detached manuscript answers no pointer event, hit-tests
 * nothing, and is invisible to a surface that queries the document.
 *
 * Inside a scroll pane, because in the app it always is (`EditorSurfaceFrame`),
 * and every piece of measured chrome is drawn in that pane and placed in its
 * coordinates (`features/editor/chrome/manuscript-overlay.ts`). An editor
 * without one is an editor whose chrome has nowhere to mount, which is not a
 * situation a writer can reach.
 */
export function createStandaloneEditor({
  content,
  extensions = [],
  ...schema
}: StandaloneEditorOptions = {}): StandaloneEditor {
  installJsdomLayoutFallbacks();
  const pane = document.createElement("div");
  pane.setAttribute("data-stable-layout-scroll", "");
  const element = document.createElement("div");
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

/**
 * Which node a query is after: a type name, or a type plus the start of its
 * text for a document holding several of the same kind.
 */
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

/**
 * The first node `match` describes, and where it is.
 *
 * Throws rather than returning null: a fixture that lost its node is a broken
 * test, and a query that answered null would fail the assertion below it with
 * the wrong story.
 */
export function requireNode(editor: Editor, match: NodeMatch): { pos: number; node: PMNode } {
  const found = findNode(editor, match);
  if (!found) throw new Error(`no ${JSON.stringify(match)} in the document`);
  return found;
}
