import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownToHtml } from "@/core/lib/clipboard";
import {
  MERIDIAN_CLIPBOARD_MIME,
  readMeridianClipboardPayload,
  serializeMeridianClipboardPayload,
  type MeridianClipboardPayload,
} from "@/core/lib/meridianClipboard";

interface ClipboardSelectionResult {
  payload: MeridianClipboardPayload;
  plainText?: string;
}

interface MeridianClipboardExtensionOptions {
  extractSelection: (
    view: EditorView,
    from: number,
    to: number,
  ) => ClipboardSelectionResult | null;
  insertPayload: (
    view: EditorView,
    payload: MeridianClipboardPayload,
    from: number,
    to: number,
  ) => boolean;
  toPlainTextFallback: (
    payload: MeridianClipboardPayload,
    view: EditorView,
    from: number,
    to: number,
  ) => string;
  fromPlainTextFallback?: (
    text: string,
    view: EditorView,
  ) => MeridianClipboardPayload | null;
  allowCut?: boolean;
}

function writeClipboard(
  clipboard: DataTransfer,
  payload: MeridianClipboardPayload,
  plainText: string,
): void {
  clipboard.setData(
    MERIDIAN_CLIPBOARD_MIME,
    serializeMeridianClipboardPayload(payload),
  );
  clipboard.setData("text/plain", plainText);
  clipboard.setData("text/html", markdownToHtml(plainText));
}

/**
 * Unified Meridian clipboard handler for CM6 editors.
 * Surfaces provide extraction/insertion strategies, but copy/cut/paste flow is shared.
 */
export function createMeridianClipboardExtension(
  options: MeridianClipboardExtensionOptions,
): Extension {
  const allowCut = options.allowCut ?? true;

  return EditorView.domEventHandlers({
    copy(event: ClipboardEvent, view: EditorView) {
      const clipboard = event.clipboardData;
      if (!clipboard) return false;

      const { from, to } = view.state.selection.main;
      if (from === to) return false;

      const selection = options.extractSelection(view, from, to);
      if (!selection) return false;

      const plainText =
        selection.plainText ??
        options.toPlainTextFallback(selection.payload, view, from, to);
      writeClipboard(clipboard, selection.payload, plainText);
      event.preventDefault();
      return true;
    },

    cut(event: ClipboardEvent, view: EditorView) {
      if (!allowCut) return false;

      const clipboard = event.clipboardData;
      if (!clipboard) return false;

      const { from, to } = view.state.selection.main;
      if (from === to) return false;

      const selection = options.extractSelection(view, from, to);
      if (!selection) return false;

      const plainText =
        selection.plainText ??
        options.toPlainTextFallback(selection.payload, view, from, to);
      writeClipboard(clipboard, selection.payload, plainText);

      view.dispatch({
        changes: { from, to, insert: "" },
        selection: { anchor: from },
      });
      event.preventDefault();
      return true;
    },

    paste(event: ClipboardEvent, view: EditorView) {
      const { from, to } = view.state.selection.main;
      const customPayload = readMeridianClipboardPayload(event.clipboardData);
      if (
        customPayload &&
        options.insertPayload(view, customPayload, from, to)
      ) {
        event.preventDefault();
        return true;
      }

      if (!options.fromPlainTextFallback) return false;
      const plainText = event.clipboardData?.getData("text/plain") ?? "";
      if (!plainText) return false;

      const plainPayload = options.fromPlainTextFallback(plainText, view);
      if (!plainPayload) return false;
      if (!options.insertPayload(view, plainPayload, from, to)) return false;

      event.preventDefault();
      return true;
    },
  });
}
