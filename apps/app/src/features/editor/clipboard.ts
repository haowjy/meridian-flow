/** Whether a clipboard direction is worth offering before the writer tries it. */
export type ClipboardAvailability = "available" | "unavailable";

export type ClipboardAccess = {
  read: ClipboardAvailability;
  write: ClipboardAvailability;
};

export type ClipboardWrite =
  | { status: "done" }
  | { status: "denied"; cause: unknown }
  | { status: "unavailable" };

export type ClipboardRead =
  | { status: "done"; html: string | null; text: string | null }
  | { status: "empty" | "denied" | "unavailable" };

export function clipboardAccess(): ClipboardAccess {
  const clipboard = browserClipboard();
  return {
    read: typeof clipboard?.read === "function" ? "available" : "unavailable",
    write:
      typeof clipboard?.write === "function" || typeof clipboard?.writeText === "function"
        ? "available"
        : "unavailable",
  };
}

export async function writeClipboardText(text: string): Promise<ClipboardWrite> {
  const clipboard = browserClipboard();
  if (typeof clipboard?.writeText !== "function") return { status: "unavailable" };
  try {
    await clipboard.writeText(text);
    return { status: "done" };
  } catch (cause) {
    return { status: "denied", cause };
  }
}

export async function writeClipboardRichText(html: string, text: string): Promise<ClipboardWrite> {
  const clipboard = browserClipboard();
  if (typeof clipboard?.write === "function" && typeof ClipboardItem === "function") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return { status: "done" };
    } catch {
      // Fall through to the plain write rather than reporting a refusal the
      // writer may not actually have.
    }
  }

  return await writeClipboardText(text);
}

export async function writeClipboardImage(blob: Blob): Promise<ClipboardWrite> {
  const clipboard = browserClipboard();
  if (typeof clipboard?.write !== "function" || typeof ClipboardItem !== "function") {
    return { status: "unavailable" };
  }
  try {
    await clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return { status: "done" };
  } catch (cause) {
    return { status: "denied", cause };
  }
}

export async function readClipboardText(): Promise<ClipboardRead> {
  const clipboard = browserClipboard();
  if (typeof clipboard?.read !== "function") return { status: "unavailable" };

  let items: readonly ClipboardItem[];
  try {
    items = await clipboard.read();
  } catch {
    return { status: "denied" };
  }

  const html = await firstClipboardFlavour(items, "text/html");
  const text = html ? null : await firstClipboardFlavour(items, "text/plain");
  if (!html && !text) return { status: "empty" };
  return { status: "done", html, text };
}

function browserClipboard(): Clipboard | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.clipboard;
}

/**
 * The clipboard's payload for one flavour, verbatim. Emptiness is tested on a
 * trimmed copy and never on the payload itself: a pasted code line's leading
 * indentation and a paragraph's trailing newline are content, and trimming
 * them is a silent edit of what the writer copied.
 */
async function firstClipboardFlavour(
  items: readonly ClipboardItem[],
  type: string,
): Promise<string | null> {
  for (const item of items) {
    if (!item.types.includes(type)) continue;
    const value = await (await item.getType(type)).text();
    if (value.trim()) return value;
  }
  return null;
}
