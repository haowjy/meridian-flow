export class ConversionRefused extends Error {
  constructor(
    readonly reason: "hostile" | "too_large" | "timeout" | "no_text" | "unreadable",
    message: string,
  ) {
    super(message);
  }
}

export const CONVERSION_LIMITS = {
  originalBytes: 100 * 1024 * 1024,
  timeMs: 20_000,
  outputChars: 1_000_000,
  epub: {
    entries: 5_000,
    entryBytes: 64 * 1024 * 1024,
    totalBytes: 256 * 1024 * 1024,
    textEntryBytes: 8 * 1024 * 1024,
    textTotalBytes: 64 * 1024 * 1024,
  },
  pdf: { pages: 2_000 },
} as const;

export function createTextBuilder(): {
  add(piece: string): boolean;
  text(): string;
} {
  const pieces: string[] = [];
  let length = 0;
  let cut = false;
  return {
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
