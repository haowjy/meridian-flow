import {
  type ClipboardCodec,
  type ClipboardElement,
  clipboardCodecRegistry,
} from "@/core/clipboard/codec";
import {
  ORC,
  MERIDIAN_CLIPBOARD_KIND,
  MERIDIAN_CLIPBOARD_VERSION,
  type MeridianClipboardElement,
  type MeridianClipboardPayload,
} from "@/core/lib/meridianClipboard";
import { findWikiLinks, pathToDisplayName } from "./wikiLinkRegex";
import {
  resolveDocumentByPath,
  resolveDocumentPathById,
} from "./resolveDocument";

export interface ReferenceClipboardElement extends ClipboardElement {
  type: "reference";
  documentId: string;
  refType: string;
  displayName: string;
  documentPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toReferenceElement(
  value: MeridianClipboardElement,
): ReferenceClipboardElement | null {
  if (!isRecord(value)) return null;
  if (value.type !== "reference") return null;
  if (typeof value.documentId !== "string" || value.documentId.length === 0) {
    return null;
  }
  if (typeof value.refType !== "string" || value.refType.length === 0) {
    return null;
  }
  if (typeof value.displayName !== "string" || value.displayName.length === 0) {
    return null;
  }
  if (
    value.documentPath !== undefined &&
    typeof value.documentPath !== "string"
  ) {
    return null;
  }
  return {
    type: "reference",
    documentId: value.documentId,
    refType: value.refType,
    displayName: value.displayName,
    documentPath: value.documentPath,
  };
}

/**
 * Build canonical wiki-link markdown from path/display name.
 */
export function formatWikiLink(path: string, displayName: string): string {
  const trimmedPath = path.trim();
  const trimmedName = displayName.trim();
  if (!trimmedPath) return "";
  if (!trimmedName || trimmedName === trimmedPath) return `[[${trimmedPath}]]`;
  return `[[${trimmedPath} | ${trimmedName}]]`;
}

const referenceClipboardCodec: ClipboardCodec<ReferenceClipboardElement> = {
  type: "reference",

  toPlainText(element) {
    const path =
      element.documentPath?.trim() ||
      resolveDocumentPathById(element.documentId)?.trim() ||
      element.displayName;
    const displayName = element.displayName || pathToDisplayName(path);
    return formatWikiLink(path, displayName);
  },

  fromPlainText(text) {
    const links = findWikiLinks(text, 0);
    if (links.length === 0) return null;

    const elements: Array<{
      position: number;
      element: ReferenceClipboardElement;
    }> = [];
    let result = "";
    let cursor = 0;

    for (const link of links) {
      result += text.slice(cursor, link.from);

      const doc = resolveDocumentByPath(link.path);
      if (!doc) {
        result += text.slice(link.from, link.to);
        cursor = link.to;
        continue;
      }

      const position = result.length;
      result += ORC;
      elements.push({
        position,
        element: {
          type: "reference",
          documentId: doc.id,
          refType: "document",
          displayName: link.displayName || doc.name,
          documentPath: doc.path,
        },
      });
      cursor = link.to;
    }

    result += text.slice(cursor);
    if (elements.length === 0) return null;
    return { text: result, elements };
  },

  toMeridian(element) {
    return {
      type: "reference",
      documentId: element.documentId,
      refType: element.refType,
      displayName: element.displayName,
      ...(element.documentPath !== undefined
        ? { documentPath: element.documentPath }
        : {}),
    };
  },

  fromMeridian(element) {
    return toReferenceElement(element);
  },
};

let isReferenceCodecRegistered = false;

export function ensureReferenceClipboardCodecRegistered(): void {
  if (isReferenceCodecRegistered) return;
  clipboardCodecRegistry.register(referenceClipboardCodec);
  isReferenceCodecRegistered = true;
}

ensureReferenceClipboardCodecRegistered();

/**
 * Convert Meridian payload text (\uFFFC placeholders) into plain text.
 * Uses registered codecs by element type.
 */
export function meridianPayloadToWikiLinkText(
  payload: MeridianClipboardPayload,
): string {
  ensureReferenceClipboardCodecRegistered();

  const byPos = new Map(payload.elements.map((item) => [item.position, item]));
  let out = "";

  for (let i = 0; i < payload.text.length; i++) {
    const char = payload.text[i];
    if (char !== ORC) {
      out += char;
      continue;
    }

    const item = byPos.get(i);
    if (!item) continue;

    const codec = clipboardCodecRegistry.get(item.element.type);
    if (!codec) continue;

    const decoded = codec.fromMeridian(item.element);
    if (!decoded) continue;

    out += codec.toPlainText(decoded);
  }

  return out;
}

/**
 * Parse plain-text wiki-links and convert resolved ones into Meridian payload.
 * Unresolved links remain plain text in the payload text.
 */
export function buildMeridianClipboardFromWikiText(
  text: string,
): MeridianClipboardPayload | null {
  ensureReferenceClipboardCodecRegistered();
  const codec =
    clipboardCodecRegistry.get<ReferenceClipboardElement>("reference");
  if (!codec?.fromPlainText) return null;

  const parsed = codec.fromPlainText(text);
  if (!parsed || parsed.elements.length === 0) return null;

  const elements = parsed.elements.map((item) => ({
    position: item.position,
    element: codec.toMeridian
      ? codec.toMeridian(item.element)
      : (item.element as unknown as MeridianClipboardElement),
  }));

  return {
    kind: MERIDIAN_CLIPBOARD_KIND,
    version: MERIDIAN_CLIPBOARD_VERSION,
    text: parsed.text,
    elements,
  };
}
