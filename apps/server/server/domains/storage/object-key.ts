/**
 * The one key rule every object-store adapter applies: what a key may be and what a listing
 * prefix may be. A prefix is a key or "" with an optional trailing `/`, and matches by plain
 * string prefix, as an S3 `ListObjects` prefix does.
 */
const SAFE_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_:+=.,@-]*$/;

export function isSafeKey(key: string): boolean {
  return SAFE_KEY_RE.test(key) && !key.split("/").some((part) => part === ".." || part === "");
}

export function isSafeKeyPrefix(prefix: string): boolean {
  return prefix === "" || isSafeKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}
