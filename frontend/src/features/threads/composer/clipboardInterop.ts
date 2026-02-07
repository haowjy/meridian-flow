import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  type ClipboardElement,
  clipboardCodecRegistry,
} from "@/core/clipboard/codec";
import { ensureReferenceClipboardCodecRegistered } from "@/core/editor/codemirror/wikiLinks";
import {
  addInlineElement,
  ORC,
  getInlineElementRanges,
  type InlineElementData,
} from "./inlineElements";
import {
  MERIDIAN_CLIPBOARD_KIND,
  MERIDIAN_CLIPBOARD_VERSION,
  type MeridianClipboardPayload,
} from "@/core/lib/meridianClipboard";

interface ComposerNormalizedPayload {
  text: string;
  elements: Array<{ position: number; data: InlineElementData }>;
}

ensureReferenceClipboardCodecRegistered();

/**
 * Build a Meridian payload from a composer selection.
 * Returns null when selection contains no reference pills.
 */
export function buildComposerClipboardPayload(
  state: EditorState,
  from: number,
  to: number,
): MeridianClipboardPayload | null {
  if (from >= to) return null;

  const selectedText = state.sliceDoc(from, to);
  const ranges = getInlineElementRanges(state, from, to);
  const elements: MeridianClipboardPayload["elements"] = [];
  for (const range of ranges) {
    if (range.from < from || range.to > to) continue;
    const codec = clipboardCodecRegistry.get(range.data.type);
    if (!codec) continue;
    const meridianElement = codec.toMeridian
      ? codec.toMeridian(range.data as ClipboardElement)
      : { ...(range.data as ClipboardElement) };
    elements.push({
      position: range.from - from,
      element: meridianElement,
    });
  }

  if (elements.length === 0) return null;

  return {
    kind: MERIDIAN_CLIPBOARD_KIND,
    version: MERIDIAN_CLIPBOARD_VERSION,
    text: selectedText,
    elements,
  };
}

function normalizeForComposer(
  payload: MeridianClipboardPayload,
): ComposerNormalizedPayload {
  const byPos = new Map(payload.elements.map((item) => [item.position, item]));
  const elements: ComposerNormalizedPayload["elements"] = [];
  let text = "";

  for (let i = 0; i < payload.text.length; i++) {
    const char = payload.text[i];
    if (char !== ORC) {
      text += char;
      continue;
    }

    const item = byPos.get(i);
    if (!item) {
      // Skip orphan placeholders from malformed payloads.
      continue;
    }

    const codec = clipboardCodecRegistry.get(item.element.type);
    if (!codec) continue;

    const decoded = codec.fromMeridian(item.element);
    if (!decoded || !isInlineElementData(decoded)) continue;

    const position = text.length;
    text += ORC;
    elements.push({
      position,
      data: decoded,
    });
  }

  return { text, elements };
}

function isInlineElementData(
  value: ClipboardElement,
): value is InlineElementData {
  const record = value as Record<string, unknown>;

  if (value.type === "reference") {
    return (
      typeof record.documentId === "string" &&
      record.documentId.length > 0 &&
      typeof record.refType === "string" &&
      record.refType.length > 0 &&
      typeof record.displayName === "string" &&
      record.displayName.length > 0 &&
      (record.documentPath === undefined ||
        typeof record.documentPath === "string")
    );
  }

  if (value.type === "image") {
    return (
      typeof record.tempFileId === "string" &&
      record.tempFileId.length > 0 &&
      typeof record.filename === "string" &&
      record.filename.length > 0 &&
      (record.previewUrl === undefined || typeof record.previewUrl === "string")
    );
  }

  return false;
}

/**
 * Insert a Meridian payload into composer and restore inline references.
 */
export function insertComposerClipboardPayload(
  view: EditorView,
  payload: MeridianClipboardPayload,
  from: number,
  to: number,
): boolean {
  const normalized = normalizeForComposer(payload);
  if (normalized.elements.length === 0) return false;

  view.dispatch({
    changes: { from, to, insert: normalized.text },
    effects: normalized.elements.map((el) =>
      addInlineElement.of({
        from: from + el.position,
        to: from + el.position + 1,
        data: el.data,
      }),
    ),
    selection: { anchor: from + normalized.text.length },
  });

  return true;
}
