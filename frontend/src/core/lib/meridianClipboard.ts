/**
 * Meridian Clipboard Interop
 *
 * Shared clipboard payload for inline pills across editors.
 * payload.text stores Object Replacement Characters (\uFFFC) and
 * payload.elements stores typed element metadata keyed by position.
 *
 * Backward compatibility:
 * - v1 payloads use `references`
 * - v2 payloads use `elements`
 */

/** Object Replacement Character — single char placeholder for inline elements */
export const ORC = "\uFFFC";
/** @deprecated Use `ORC` instead */
export const ORC_CHAR = ORC;
export const MERIDIAN_CLIPBOARD_MIME =
  "application/x-meridian-reference-pills+json";
export const MERIDIAN_CLIPBOARD_KIND = "meridian-reference-pills";
export const MERIDIAN_CLIPBOARD_VERSION = 2;
const MERIDIAN_CLIPBOARD_VERSION_V1 = 1;

export type MeridianClipboardElement = {
  type: string;
  [key: string]: unknown;
};

export interface MeridianClipboardPositionedElement {
  /** Position of \uFFFC in payload.text */
  position: number;
  element: MeridianClipboardElement;
}

export interface MeridianClipboardPayload {
  kind: typeof MERIDIAN_CLIPBOARD_KIND;
  version: typeof MERIDIAN_CLIPBOARD_VERSION;
  text: string;
  elements: MeridianClipboardPositionedElement[];
}

interface MeridianClipboardReferenceV1 {
  position: number;
  documentId: string;
  refType: string;
  displayName: string;
  documentPath?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidPosition(
  position: unknown,
  textLength: number,
): position is number {
  return (
    typeof position === "number" &&
    Number.isInteger(position) &&
    position >= 0 &&
    position < textLength
  );
}

function isValidMeridianElement(
  value: unknown,
): value is MeridianClipboardElement {
  if (!isObject(value)) return false;
  const type = value.type;
  return typeof type === "string" && type.length > 0;
}

function toMeridianElement(
  value: MeridianClipboardElement,
): MeridianClipboardElement {
  return { ...value };
}

function isValidReferenceV1(
  value: unknown,
  textLength: number,
): value is MeridianClipboardReferenceV1 {
  if (!isObject(value)) return false;
  const position = value.position;
  if (!isValidPosition(position, textLength)) return false;

  const documentId = value.documentId;
  if (typeof documentId !== "string" || documentId.length === 0) return false;

  const refType = value.refType;
  if (typeof refType !== "string" || refType.length === 0) return false;

  const displayName = value.displayName;
  if (typeof displayName !== "string" || displayName.length === 0) return false;

  if (
    value.documentPath !== undefined &&
    typeof value.documentPath !== "string"
  ) {
    return false;
  }
  return true;
}

function parseV2(
  parsed: Record<string, unknown>,
): MeridianClipboardPayload | null {
  if (!Array.isArray(parsed.elements)) return null;
  if (typeof parsed.text !== "string") return null;

  const elements: MeridianClipboardPositionedElement[] = [];
  for (const item of parsed.elements) {
    if (!isObject(item)) return null;
    const position = item.position;
    if (!isValidPosition(position, parsed.text.length)) return null;
    if (!isValidMeridianElement(item.element)) return null;
    elements.push({
      position,
      element: toMeridianElement(item.element),
    });
  }

  elements.sort((a, b) => a.position - b.position);

  return {
    kind: MERIDIAN_CLIPBOARD_KIND,
    version: MERIDIAN_CLIPBOARD_VERSION,
    text: parsed.text,
    elements,
  };
}

function parseV1(
  parsed: Record<string, unknown>,
): MeridianClipboardPayload | null {
  if (!Array.isArray(parsed.references)) return null;
  if (typeof parsed.text !== "string") return null;

  const elements: MeridianClipboardPositionedElement[] = [];
  for (const ref of parsed.references) {
    if (!isValidReferenceV1(ref, parsed.text.length)) return null;
    elements.push({
      position: ref.position,
      element: {
        type: "reference",
        documentId: ref.documentId,
        refType: ref.refType,
        displayName: ref.displayName,
        ...(ref.documentPath !== undefined
          ? { documentPath: ref.documentPath }
          : {}),
      },
    });
  }

  elements.sort((a, b) => a.position - b.position);

  return {
    kind: MERIDIAN_CLIPBOARD_KIND,
    version: MERIDIAN_CLIPBOARD_VERSION,
    text: parsed.text,
    elements,
  };
}

/**
 * Parse and validate Meridian clipboard payload.
 * Returns null for malformed or incompatible data.
 * v1 payloads are normalized to v2 shape.
 */
export function parseMeridianClipboardPayload(
  raw: string,
): MeridianClipboardPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    if (parsed.kind !== MERIDIAN_CLIPBOARD_KIND) return null;
    if (parsed.version === MERIDIAN_CLIPBOARD_VERSION) {
      return parseV2(parsed);
    }
    if (parsed.version === MERIDIAN_CLIPBOARD_VERSION_V1) {
      return parseV1(parsed);
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeMeridianClipboardPayload(
  payload: MeridianClipboardPayload,
): string {
  return JSON.stringify(payload);
}

export function readMeridianClipboardPayload(
  clipboard: DataTransfer | null,
): MeridianClipboardPayload | null {
  if (!clipboard) return null;
  const raw = clipboard.getData(MERIDIAN_CLIPBOARD_MIME);
  if (!raw) return null;
  return parseMeridianClipboardPayload(raw);
}
