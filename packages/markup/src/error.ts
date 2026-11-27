export interface CodecParseErrorLocation {
  line?: number;
  column?: number;
}

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
