/** Editor composition for the host-neutral suggestion interaction lease. */

import type { Editor } from "@tiptap/core";

import type { SuggestionHost } from "@/core/completion";

import { getEditorChrome } from "./chrome";

export function editorSuggestionHost(
  editor: Editor,
  reach: "prose" | "chrome",
): SuggestionHost | null {
  const chrome = getEditorChrome(editor);
  if (!chrome) return null;

  return {
    register({ id, bindings, retreat }) {
      const releaseKeymap = chrome.registerKeymap({
        id,
        scope: "layer",
        // Registration precedes the React layer by one frame so the first key
        // cannot outrun its menu. Chrome retains that host policy.
        layer: null,
        ...(reach === "chrome" ? { reach: "chrome" as const } : {}),
        bindings,
      });
      let releaseRetreat: (() => void) | null;
      try {
        releaseRetreat = chrome.registerLayerRetreat({ ownerId: id, ...retreat });
      } catch (error) {
        releaseKeymap();
        throw error;
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          releaseRetreat?.();
          releaseRetreat = null;
          releaseKeymap();
        },
      };
    },
  };
}
