/**
 * URL validation for the editor's link and image rendering.
 *
 * Two validation functions with different security models:
 * - safeExternalUrl: for link opening (Cmd+Click). Blocks javascript:,
 *   data:, file:, same-origin, and relative URLs.
 * - safeImageUrl: for image rendering. Returns trust level (trusted/external)
 *   and blocks private network targets to prevent SSRF.
 */

// Trusted image URL prefixes (project uploads served from our API).
// CDN prefix will be added when available.
const TRUSTED_IMAGE_PREFIXES: string[] = [
  // Same-origin upload endpoint -- dynamically resolved at call time
  // via window.location.origin in isTrustedImageUrl.
  // CDN prefix will be added here when available.
]

/**
 * Check if an image URL is from a trusted source (project uploads).
 * Trusted images are labeled separately from external images.
 */
export function isTrustedImageUrl(src: string): boolean {
  try {
    const url = new URL(src)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false

    const uploadPrefix = `${window.location.origin}/api/uploads/`
    if (url.href.startsWith(uploadPrefix)) return true

    return TRUSTED_IMAGE_PREFIXES.some((prefix) => url.href.startsWith(prefix))
  } catch {
    return false
  }
}

/**
 * Validate a URL for link opening (Cmd+Click, context menu "Open").
 *
 * Only allows absolute http: and https: URLs. Blocks:
 * - javascript:, data:, file: schemes (XSS vectors)
 * - Same-origin URLs (prevents navigation to app routes like /logout)
 * - Relative URLs (rejected by URL constructor)
 *
 * Returns the sanitized href string, or null if blocked.
 */
export function safeExternalUrl(href: string): string | null {
  try {
    const url = new URL(href) // throws on relative URLs
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.origin === window.location.origin) return null // block same-origin
    return url.href
  } catch {
    return null // reject relative URLs
  }
}

/**
 * Check if a hostname resolves to a private/reserved network address.
 * Blocks SSRF targets: loopback, link-local, private RFC1918/RFC4193,
 * and special TLDs.
 */
function isPrivateHostname(hostname: string): boolean {
  // Loopback (full 127.0.0.0/8 range + IPv6 + 0.0.0.0)
  if (
    hostname === "localhost" ||
    hostname.startsWith("127.") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]"
  ) {
    return true
  }
  // IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)
  if (/^(\[)?::ffff:127\./i.test(hostname)) return true
  if (/^(\[)?::ffff:0\.0\.0\.0/i.test(hostname)) return true
  // RFC1918 private IPv4 ranges
  if (hostname.startsWith("10.")) return true
  if (hostname.startsWith("192.168.")) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true
  // Link-local IPv4 (169.254.x.x)
  if (hostname.startsWith("169.254.")) return true
  // IPv6 ULA (fc00::/7 covers fc00:: and fd00::)
  if (/^f[cd][0-9a-f]{2}:/i.test(hostname)) return true
  if (/^\[f[cd][0-9a-f]{2}:/i.test(hostname)) return true
  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/i.test(hostname)) return true
  if (/^\[fe[89ab][0-9a-f]:/i.test(hostname)) return true
  // Special TLDs
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return true
  }
  return false
}

/** Result from safeImageUrl validation */
export type SafeImageResult =
  | { type: "trusted"; href: string }
  | { type: "external"; href: string }

/**
 * Validate an image URL for rendering in the editor.
 *
 * Returns trust level for the URL:
 * - "trusted": project uploads
 * - "external": third-party URLs
 * - null: blocked entirely (bad protocol, private network target)
 *
 * Blocks private network targets to prevent SSRF:
 * - localhost, 127.0.0.1, ::1
 * - 10.x.x.x, 192.168.x.x, 172.16-31.x.x
 * - .local, .internal TLDs
 */
export function safeImageUrl(src: string): SafeImageResult | null {
  try {
    const url = new URL(src)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null

    // Check trusted BEFORE SSRF — dev environment uses localhost for uploads
    if (isTrustedImageUrl(url.href)) {
      return { type: "trusted", href: url.href }
    }

    // Block private network targets (SSRF prevention)
    if (isPrivateHostname(url.hostname)) return null
    return { type: "external", href: url.href }
  } catch {
    return null
  }
}
