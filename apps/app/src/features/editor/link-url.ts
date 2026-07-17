/** Normalize writer-entered link targets for the editor link mark. */

const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function normalizeLinkHref(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const hasExplicitScheme = EXPLICIT_SCHEME.test(value);
  const candidate = value.startsWith("//")
    ? `https:${value}`
    : hasExplicitScheme
      ? value
      : `https://${value}`;

  try {
    const url = new URL(candidate);
    if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
    if (url.protocol === "mailto:") return url.pathname ? candidate : null;
    return url.hostname ? candidate : null;
  } catch {
    return null;
  }
}
