/** Limits on turning a stranger's EPUB or PDF into text. A breach refuses the file. */
export class ConversionRefused extends Error {
  constructor(
    readonly reason: "hostile" | "too_large" | "timeout" | "no_text" | "unreadable",
    message: string,
  ) {
    super(message);
  }
}

export const CONVERSION_LIMITS = {
  /** The stored file: larger ones are not read into memory. */
  originalBytes: 100 * 1024 * 1024,
  /** Wall-clock budget for one conversion, inside `read`'s 30 s timeout. */
  timeMs: 20_000,
  /** The Markdown kept: the rest is cut and the text says so. */
  outputChars: 1_000_000,
  epub: {
    entries: 5_000,
    /** Declared uncompressed size of one entry, and of all entries together. */
    entryBytes: 64 * 1024 * 1024,
    totalBytes: 256 * 1024 * 1024,
    /** What is inflated: the book's XML and XHTML only, never its images. */
    textEntryBytes: 8 * 1024 * 1024,
    textTotalBytes: 64 * 1024 * 1024,
  },
  pdf: { pages: 2_000 },
} as const;

/** Throws when the conversion's deadline has passed. */
export function checkDeadline(deadline: number): void {
  if (Date.now() > deadline)
    throw new ConversionRefused("timeout", "The conversion took too long.");
}

/** Joins converted pieces, cutting at the output cap. */
export function createTextBuilder(): {
  add(piece: string): boolean;
  text(): string;
} {
  const pieces: string[] = [];
  let length = 0;
  let cut = false;
  return {
    /** False once the cap is reached: nothing more is kept. */
    add(piece) {
      if (cut) return false;
      if (length + piece.length > CONVERSION_LIMITS.outputChars) {
        cut = true;
        pieces.push(
          piece.slice(0, CONVERSION_LIMITS.outputChars - length),
          `\n\n[The text stops here: the file is longer than ${CONVERSION_LIMITS.outputChars.toLocaleString("en-US")} characters.]`,
        );
        return false;
      }
      pieces.push(piece);
      length += piece.length;
      return true;
    },
    text: () => pieces.join("\n\n").trim(),
  };
}
