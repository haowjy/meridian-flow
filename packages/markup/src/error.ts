/** Typed parse errors surfaced by the markup codec. */

export interface CodecParseErrorLocation {
  line?: number;
  column?: number;
}

/** Typed, catchable parse failure for syntactically invalid markdown/MDX input. */
export class CodecParseError extends Error {
  readonly line?: number;
  readonly column?: number;

  constructor(message: string, location: CodecParseErrorLocation = {}, cause?: unknown) {
    super(message, { cause });
    this.name = "CodecParseError";
    this.line = location.line;
    this.column = location.column;
  }
}
