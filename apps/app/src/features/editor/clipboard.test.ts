// @vitest-environment jsdom
/**
 * What the one clipboard boundary reports back.
 *
 * Four surfaces read these results and each draws its own answer from them, so
 * the three browser facts have to stay apart: a direction the browser never
 * offered, a direction it offered and refused, and a refusal that still carried
 * the browser's own error. That last one is not a detail — the object lane's
 * feedback translates `NotAllowedError` into a sentence about permissions, and a
 * result that swallowed it would flatten every failure into "that did not work".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clipboardAccess,
  readClipboardText,
  writeClipboardImage,
  writeClipboardRichText,
  writeClipboardText,
} from "./clipboard";

const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

// jsdom ships no `ClipboardItem`, and the adapter asks for it by name before it
// will write two flavours or a blob. The browser has it; the harness does not.
if (typeof globalThis.ClipboardItem === "undefined") {
  class StubClipboardItem {
    constructor(readonly flavours: Record<string, Blob>) {}
  }
  Object.defineProperty(globalThis, "ClipboardItem", { value: StubClipboardItem });
}

afterEach(() => {
  if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

/** A clipboard with only the parts the test cares about, as a browser exposes it. */
function stubClipboard(clipboard: Partial<Clipboard>): void {
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

function plainTextItem(text: string): ClipboardItem {
  return {
    types: ["text/plain"],
    getType: async () => ({ text: async () => text }) as Blob,
  } as unknown as ClipboardItem;
}

describe("what the clipboard offers before anything is pressed", () => {
  it("says a browser exposes neither direction rather than failing later", () => {
    stubClipboard({});

    expect(clipboardAccess()).toEqual({ read: "unavailable", write: "unavailable" });
  });

  it("counts writing as available when either write door exists", () => {
    stubClipboard({ writeText: vi.fn() });

    expect(clipboardAccess()).toEqual({ read: "unavailable", write: "available" });
  });
});

describe("writing text", () => {
  it("takes the words", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });

    await expect(writeClipboardText("Kael pressed")).resolves.toEqual({ status: "done" });
    expect(writeText).toHaveBeenCalledWith("Kael pressed");
  });

  it("reports a browser that never offered the page a clipboard", async () => {
    stubClipboard({});

    await expect(writeClipboardText("Kael pressed")).resolves.toEqual({ status: "unavailable" });
  });

  it("keeps the browser's own refusal, so a surface can say which one it was", async () => {
    const denial = new DOMException("write permission denied", "NotAllowedError");
    stubClipboard({ writeText: vi.fn().mockRejectedValue(denial) });

    await expect(writeClipboardText("Kael pressed")).resolves.toEqual({
      status: "denied",
      cause: denial,
    });
  });
});

describe("writing a passage as structure and as words", () => {
  it("writes both flavours when the browser takes them", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ write, writeText: vi.fn() });

    await expect(writeClipboardRichText("<p>Kael</p>", "Kael")).resolves.toEqual({
      status: "done",
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("writes the words alone when the browser has no structured write", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });

    await expect(writeClipboardRichText("<p>Kael</p>", "Kael")).resolves.toEqual({
      status: "done",
    });
    expect(writeText).toHaveBeenCalledWith("Kael");
  });

  it("falls back to the plain write rather than losing the copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({
      write: vi.fn().mockRejectedValue(new Error("two flavours refused")),
      writeText,
    });

    await expect(writeClipboardRichText("<p>Kael</p>", "Kael")).resolves.toEqual({
      status: "done",
    });
    expect(writeText).toHaveBeenCalledWith("Kael");
  });

  it("reports the refusal the fallback met, not the one before it", async () => {
    const denial = new DOMException("clipboard blocked", "NotAllowedError");
    stubClipboard({
      write: vi.fn().mockRejectedValue(new Error("two flavours refused")),
      writeText: vi.fn().mockRejectedValue(denial),
    });

    await expect(writeClipboardRichText("<p>Kael</p>", "Kael")).resolves.toEqual({
      status: "denied",
      cause: denial,
    });
  });
});

describe("writing an image", () => {
  it("reports a browser with no blob write at all", async () => {
    stubClipboard({ writeText: vi.fn() });

    await expect(writeClipboardImage(new Blob([], { type: "image/png" }))).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("keeps a blocked image write's own error", async () => {
    const denial = new DOMException("not allowed", "NotAllowedError");
    stubClipboard({ write: vi.fn().mockRejectedValue(denial) });

    await expect(writeClipboardImage(new Blob([], { type: "image/png" }))).resolves.toEqual({
      status: "denied",
      cause: denial,
    });
  });
});

describe("reading", () => {
  it("reports a read this browser does not offer", async () => {
    stubClipboard({ writeText: vi.fn() });

    await expect(readClipboardText()).resolves.toEqual({ status: "unavailable" });
  });

  it("reports a read the browser refuses", async () => {
    stubClipboard({ read: vi.fn().mockRejectedValue(new Error("denied")) });

    await expect(readClipboardText()).resolves.toEqual({ status: "denied" });
  });

  it("reports a clipboard holding nothing this page can take", async () => {
    stubClipboard({ read: vi.fn().mockResolvedValue([plainTextItem("   ")]) });

    await expect(readClipboardText()).resolves.toEqual({ status: "empty" });
  });

  it("hands back plain text with its own spacing intact", async () => {
    const indented = "    a line that means its indentation";
    stubClipboard({ read: vi.fn().mockResolvedValue([plainTextItem(indented)]) });

    await expect(readClipboardText()).resolves.toEqual({
      status: "done",
      html: null,
      text: indented,
    });
  });
});
