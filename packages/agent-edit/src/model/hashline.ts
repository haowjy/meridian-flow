export interface Hashline {
  hash: string;
  body: string;
}

export function toHashline(hash: string, body: string): string {
  return body.includes("\n") ? `${hash}|\n${body}` : `${hash}|${body}`;
}

export function splitHashline(serialized: string): Hashline | null {
  const separator = serialized.indexOf("|");
  if (separator < 0) return null;
  return { hash: serialized.slice(0, separator), body: serialized.slice(separator + 1) };
}
