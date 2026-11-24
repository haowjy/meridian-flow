const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare const parsedRequestId: unique symbol;
export type ParsedRequestId = string & { readonly [parsedRequestId]: true };

export function parseRequestId(value: unknown): ParsedRequestId | null {
  if (typeof value !== "string" || !REQUEST_ID_RE.test(value)) return null;
  return value.toLowerCase() as ParsedRequestId;
}

export function isUuid(value: string): value is ParsedRequestId {
  return parseRequestId(value) !== null;
}
