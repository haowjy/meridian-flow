import { describe, expect, it, vi } from "vitest"

import {
  isTrustedImageUrl,
  safeExternalUrl,
  safeImageUrl,
} from "./url-validation"

// Mock window.location.origin for consistent test behavior
const mockOrigin = "https://app.meridian.example"

vi.stubGlobal("window", {
  location: { origin: mockOrigin },
})

describe("safeExternalUrl", () => {
  it("allows https URLs", () => {
    expect(safeExternalUrl("https://example.com/page")).toBe(
      "https://example.com/page",
    )
  })

  it("allows http URLs", () => {
    expect(safeExternalUrl("http://example.com/page")).toBe(
      "http://example.com/page",
    )
  })

  it("blocks javascript: URLs", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull()
  })

  it("blocks data: URLs", () => {
    expect(safeExternalUrl("data:text/html,<h1>Hello</h1>")).toBeNull()
  })

  it("blocks file: URLs", () => {
    expect(safeExternalUrl("file:///etc/passwd")).toBeNull()
  })

  it("blocks same-origin URLs", () => {
    expect(safeExternalUrl(`${mockOrigin}/logout`)).toBeNull()
  })

  it("rejects relative URLs", () => {
    expect(safeExternalUrl("/relative/path")).toBeNull()
  })

  it("rejects malformed URLs", () => {
    expect(safeExternalUrl("not a url")).toBeNull()
  })

  it("rejects empty string", () => {
    expect(safeExternalUrl("")).toBeNull()
  })

  it("blocks ftp: URLs", () => {
    expect(safeExternalUrl("ftp://files.example.com/doc")).toBeNull()
  })
})

describe("safeImageUrl", () => {
  it("returns 'external' for valid https URL", () => {
    const result = safeImageUrl("https://images.example.com/photo.jpg")
    expect(result).toEqual({
      type: "external",
      href: "https://images.example.com/photo.jpg",
    })
  })

  it("returns 'external' for valid http URL", () => {
    const result = safeImageUrl("http://images.example.com/photo.jpg")
    expect(result).toEqual({
      type: "external",
      href: "http://images.example.com/photo.jpg",
    })
  })

  it("returns 'trusted' for same-origin upload URL", () => {
    const result = safeImageUrl(
      `${mockOrigin}/api/uploads/image-123.png`,
    )
    expect(result).toEqual({
      type: "trusted",
      href: `${mockOrigin}/api/uploads/image-123.png`,
    })
  })

  it("blocks javascript: URLs", () => {
    expect(safeImageUrl("javascript:alert(1)")).toBeNull()
  })

  it("blocks data: URLs", () => {
    expect(safeImageUrl("data:image/png;base64,abc123")).toBeNull()
  })

  it("blocks localhost", () => {
    expect(safeImageUrl("http://localhost/image.png")).toBeNull()
  })

  it("blocks 127.0.0.1", () => {
    expect(safeImageUrl("http://127.0.0.1/image.png")).toBeNull()
  })

  it("blocks ::1", () => {
    expect(safeImageUrl("http://[::1]/image.png")).toBeNull()
  })

  it("blocks 10.x.x.x private network", () => {
    expect(safeImageUrl("http://10.0.0.1/image.png")).toBeNull()
    expect(safeImageUrl("http://10.255.255.255/image.png")).toBeNull()
  })

  it("blocks 192.168.x.x private network", () => {
    expect(safeImageUrl("http://192.168.1.1/image.png")).toBeNull()
    expect(safeImageUrl("http://192.168.0.100/image.png")).toBeNull()
  })

  it("blocks 172.16-31.x.x private network", () => {
    expect(safeImageUrl("http://172.16.0.1/image.png")).toBeNull()
    expect(safeImageUrl("http://172.31.255.255/image.png")).toBeNull()
  })

  it("allows 172.32.x.x (not private)", () => {
    const result = safeImageUrl("http://172.32.0.1/image.png")
    expect(result).not.toBeNull()
    expect(result?.type).toBe("external")
  })

  it("blocks .local TLD", () => {
    expect(safeImageUrl("http://myhost.local/image.png")).toBeNull()
  })

  it("blocks .internal TLD", () => {
    expect(safeImageUrl("http://service.internal/image.png")).toBeNull()
  })

  it("rejects relative URLs", () => {
    expect(safeImageUrl("./image.png")).toBeNull()
  })

  it("rejects malformed URLs", () => {
    expect(safeImageUrl("not a url")).toBeNull()
  })
})

describe("isTrustedImageUrl", () => {
  it("returns true for same-origin upload URL", () => {
    expect(
      isTrustedImageUrl(`${mockOrigin}/api/uploads/image.png`),
    ).toBe(true)
  })

  it("returns false for external URL", () => {
    expect(isTrustedImageUrl("https://example.com/image.png")).toBe(false)
  })

  it("returns false for javascript: URL", () => {
    expect(isTrustedImageUrl("javascript:alert(1)")).toBe(false)
  })

  it("returns false for relative URL", () => {
    expect(isTrustedImageUrl("/api/uploads/image.png")).toBe(false)
  })
})
