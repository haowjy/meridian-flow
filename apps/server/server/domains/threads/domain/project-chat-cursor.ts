/** Strict opaque keyset cursor shared by Project-chat page policies. */
import { isUuid } from "../../../shared/uuid.js";
import type { ProjectChatCursorKey } from "../ports/repositories.js";

const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function isCanonicalBase64Url(value: string): boolean {
  return (
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

function isExactTimestamp(value: string): boolean {
  if (!EXACT_UTC_TIMESTAMP.test(value) || value.startsWith("0000-")) return false;
  const milliseconds = Date.parse(`${value.slice(0, 23)}Z`);
  return (
    Number.isFinite(milliseconds) &&
    `${new Date(milliseconds).toISOString().slice(0, 23)}${value.slice(23)}` === value
  );
}

export function encodeProjectChatCursor(key: ProjectChatCursorKey): string {
  return Buffer.from(JSON.stringify({ v: 1, a: key.sortAt, i: key.threadId })).toString(
    "base64url",
  );
}

export function decodeProjectChatCursor(cursor: string): ProjectChatCursorKey {
  try {
    if (!isCanonicalBase64Url(cursor)) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "a,i,v" ||
      record.v !== 1 ||
      typeof record.a !== "string" ||
      !isExactTimestamp(record.a) ||
      typeof record.i !== "string" ||
      !isUuid(record.i)
    ) {
      throw new Error();
    }
    return { sortAt: record.a, threadId: record.i.toLowerCase() };
  } catch {
    throw new Error("Invalid Project chat cursor");
  }
}
