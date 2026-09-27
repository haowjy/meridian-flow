/** Output contract: compact text by default, one JSON object or NDJSON with --json, errors on stderr. */
import { CliError } from "./cli-error";

export interface Io {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export type OutputMode = { json: boolean; fields?: readonly string[] };

export class Output {
  constructor(
    private readonly io: Io,
    readonly mode: OutputMode,
  ) {}

  get json(): boolean {
    return this.mode.json;
  }

  /**
   * For nested runs inside a single-result command: their text progress goes to
   * stderr (nothing under --json) so stdout stays exactly one result.
   */
  progressOnly(): Output {
    const discard = { write: () => true };
    return new Output(
      { stdout: discard, stderr: this.mode.json ? discard : this.io.stderr },
      { json: false },
    );
  }

  /** Final result of a non-streaming command: one JSON object, or rendered text. */
  result<T>(value: T, renderText: (value: T) => string): void {
    if (this.mode.json) {
      this.io.stdout.write(`${JSON.stringify(selectFields(value, this.mode.fields))}\n`);
      return;
    }
    const text = renderText(value);
    if (text) this.io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  /** One stream record: an NDJSON line with --json, otherwise a text line (null skips). */
  record(value: Record<string, unknown>, textLine: string | null, textStream: "out" | "err"): void {
    if (this.mode.json) {
      this.io.stdout.write(`${JSON.stringify(value)}\n`);
      return;
    }
    if (textLine === null) return;
    (textStream === "out" ? this.io.stdout : this.io.stderr).write(`${textLine}\n`);
  }

  /** Text-mode stdout payload (e.g. `send`'s final answer); suppressed under --json. */
  text(text: string): void {
    if (!this.mode.json) this.io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  /** Human-only progress or notes; never mixed into machine output. */
  note(text: string): void {
    if (!this.mode.json) this.io.stderr.write(`${text}\n`);
  }

  error(error: CliError): void {
    if (this.mode.json) {
      this.io.stderr.write(
        `${JSON.stringify({
          error: error.message,
          code: error.code,
          ...(error.hint ? { hint: error.hint } : {}),
          ...(error.details !== undefined ? { details: error.details } : {}),
        })}\n`,
      );
      return;
    }
    this.io.stderr.write(`error: ${error.message}\n`);
    if (error.hint) this.io.stderr.write(`hint: ${error.hint}\n`);
  }
}

/** gh-style `--fields a,b`: keeps top-level keys of an object or of each array item. */
export function selectFields<T>(value: T, fields: readonly string[] | undefined): unknown {
  if (!fields?.length) return value;
  const pick = (item: unknown): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const missing = fields.filter((field) => !(field in record));
    if (missing.length === fields.length) {
      throw new CliError("usage", `Unknown field(s): ${missing.join(", ")}`, {
        hint: `Available fields: ${Object.keys(record).join(", ")}`,
      });
    }
    return Object.fromEntries(fields.filter((field) => field in record).map((f) => [f, record[f]]));
  };
  return Array.isArray(value) ? value.map(pick) : pick(value);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars, --full to show)`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
