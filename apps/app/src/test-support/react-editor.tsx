/**
 * A React root over one editor, for the surfaces a writer opens on the page.
 *
 * A chrome or node-view test needs four things alive at once and in order: the
 * act environment React asserts on, a manuscript in the page, a root whose
 * unmount runs BEFORE the editor is destroyed — a portal still reaching into a
 * torn-down view throws out of teardown — and a page left empty afterwards,
 * because a surface that portals to the body is invisible to `container` and
 * would otherwise answer the next test's query.
 *
 * Every file that assembled that by hand drifted a little: some removed the
 * editor host, some only the container, some cleared the body, some restored
 * the act flag and some left it set.
 */
import type { Editor } from "@tiptap/core";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { createStandaloneEditor, type StandaloneEditorOptions } from "./standalone-editor";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

export type ReactEditorFixtureOptions = StandaloneEditorOptions & {
  /**
   * Render over an editor the test already owns — a collab pair's local one,
   * where the claim names a peer. Its destruction stays with its owner.
   */
  editor?: Editor;
};

export type ReactEditorFixture = {
  editor: Editor;
  /** Where `render` puts the tree. Portalled chrome lands on the body instead. */
  container: HTMLElement;
  /**
   * Render under `act`. Synchronous work has flushed by the time it returns;
   * `await` it when the surface settles over a microtask.
   */
  render: (node: ReactNode) => Promise<void>;
  destroy: () => void;
};

/** The manuscript, in the page, and who is responsible for closing it. */
function mountEditor(options: ReactEditorFixtureOptions): { editor: Editor; destroy: () => void } {
  const { editor, ...editorOptions } = options;
  if (!editor) return createStandaloneEditor(editorOptions);
  // A collab pair builds its editors detached, so a borrowed one still has to
  // reach the page before anything can press it. Its own host rather than the
  // body: `EditorContent` adopts every sibling of the manuscript when it takes
  // it over, and the body's other children are not the manuscript.
  document.body.append(editor.view.dom.parentElement ?? editor.view.dom);
  return { editor, destroy: () => {} };
}

export function createReactEditorFixture(
  options: ReactEditorFixtureOptions = {},
): ReactEditorFixture {
  const actGlobal = globalThis as ActGlobal;
  const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;

  const mounted = mountEditor(options);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  return {
    editor: mounted.editor,
    container,
    render: async (node) => {
      await act(() => {
        root.render(node);
      });
    },
    destroy: () => {
      act(() => root.unmount());
      mounted.destroy();
      actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      document.body.replaceChildren();
    },
  };
}
