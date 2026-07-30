/**
 * The browser's clipboard, as one boundary.
 *
 * Four surfaces reach for it — the menu's Cut/Copy/Paste over a selection, a
 * diagram's source and its rendered image, a link's address, the prose a schema
 * repair rescued — and every one of them meets the same three browser facts:
 * the API may never be handed to the page, a page that has it can still be
 * refused this write, and a two-flavour write can be refused where the plain
 * one is taken. Answered four times, those facts disagree about whether a
 * failed copy throws, greys a row, or closes a menu as though it had worked —
 * and a menu that closes on a refusal has told the writer their words were
 * copied (law 5).
 *
 * So capability and failure truth live here once, and a surface chooses only
 * its payload and where the answer goes.
 *
 * What is NOT here: what to copy. Serializing a ProseMirror selection is the
 * document's business (`surfaces/formatting/clipboard-commands.ts`), rendering
 * a diagram to PNG is the object lane's, and neither is a browser concern.
 */

/** Whether a clipboard direction is worth offering before the writer tries it. */
export type ClipboardAvailability = "available" | "unavailable";

export type ClipboardAccess = {
  read: ClipboardAvailability;
  write: ClipboardAvailability;
};

/**
 * What a write did.
 *
 * `cause` is the browser's own rejection, kept rather than summarized: a
 * surface that reports failures as Errors needs `NotAllowedError` and
 * `SecurityError` to arrive intact, because they mean different things to the
 * writer and only the browser knows which refusal it made.
 */
export type ClipboardWrite =
  /** The clipboard took it. */
  | { status: "done" }
  /** It exposes the direction and refused this one (permission, hostile context). */
  | { status: "denied"; cause: unknown }
  /** This browser does not expose writing to the page at all. */
  | { status: "unavailable" };

/**
 * What a read found. `done` always carries at least one flavour; a clipboard
 * holding only whitespace is `empty`, because pasting it is a silent no-op the
 * writer would read as a broken menu.
 */
export type ClipboardRead =
  | { status: "done"; html: string | null; text: string | null }
  | { status: "empty" | "denied" | "unavailable" };

/**
 * What the clipboard offers before the writer presses anything. A capability
 * check only: a permission prompt is a fine outcome, so "might be denied" is
 * not a reason to grey a control in advance.
 */
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

/** Put a sentence, an address, or a block of source on the clipboard. */
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

/**
 * Put a passage on the clipboard as structure and as words.
 *
 * Both flavours, so a paste back into a manuscript keeps its blocks and a paste
 * into a plain text field still reads as the sentence it was. A browser that
 * refuses the pair may still take the plain one, and losing the marks beats
 * losing the copy.
 */
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

/**
 * Put an image on the clipboard, under its own type.
 *
 * The fussiest corner of the API: a browser can expose `write`, accept text
 * through it, and refuse a blob. The caller has already decided the bytes are
 * one a clipboard accepts (PNG, in practice).
 */
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

/**
 * What the clipboard is holding, as structure when it has it.
 *
 * Reading is refused far more often than writing — whole browsers withhold it —
 * so the three refusals are kept apart: a browser that never offered the
 * direction, one that said no, and a clipboard with nothing this page can use.
 */
export async function readClipboardText(): Promise<ClipboardRead> {
  const clipboard = browserClipboard();
  if (typeof clipboard?.read !== "function") return { status: "unavailable" };

  let items: readonly ClipboardItem[];
  try {
    items = await clipboard.read();
  } catch {
    // Denied, dismissed, or a browser that exposes `read` and then refuses it.
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
