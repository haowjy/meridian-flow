import { CliError } from "./cli-error";

export const TERMINAL_KEYS = ["type", "command", "outcome", "reason"] as const;

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

  progressOnly(): Output {
    const discard = { write: () => true };
    return new Output(
      { stdout: discard, stderr: this.mode.json ? discard : this.io.stderr },
      { json: false },
    );
  }

  result<T>(value: T, renderText: (value: T) => string): void {
    if (this.mode.json) {
      this.io.stdout.write(`${JSON.stringify(selectFields(value, this.mode.fields))}\n`);
      return;
    }
    const text = renderText(value);
    if (text) this.io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  record(value: Record<string, unknown>, textLine: string | null, textStream: "out" | "err"): void {
    if (this.mode.json) {
      const fields = this.mode.fields;
      const line = fields?.length
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([key]) =>
                key === "type" ||
                (value.type === "result" && TERMINAL_KEYS.some((reserved) => reserved === key)) ||
                fields.includes(key),
            ),
          )
        : value;
      this.io.stdout.write(`${JSON.stringify(line)}\n`);
      return;
    }
    if (textLine === null) return;
    (textStream === "out" ? this.io.stdout : this.io.stderr).write(`${textLine}\n`);
  }

  text(text: string): void {
    if (!this.mode.json) this.io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  always(text: string, record: Record<string, unknown>): void {
    this.io.stderr.write(this.mode.json ? `${JSON.stringify(record)}\n` : `${text}\n`);
  }

  note(text: string): void {
    if (!this.mode.json) this.io.stderr.write(`${text}\n`);
  }

  error(error: CliError): void {
    if (this.mode.json) {
      this.io.stderr.write(
        `${JSON.stringify({
          error: error.message,
          code: error.code,
          ...error.occurrence,
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

export function selectFields<T>(value: T, fields: readonly string[] | undefined): unknown {
  if (!fields?.length) return value;
  const pick = (item: unknown): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const missing = fields.filter((field) => !(field in record));
    if (missing.length === fields.length && record.type !== "result") {
      throw new CliError("usage", `Unknown field(s): ${missing.join(", ")}`, {
        hint: `Available fields: ${Object.keys(record).join(", ")}`,
      });
    }
    const selected =
      record.type === "result" ? [...new Set([...TERMINAL_KEYS, ...fields])] : fields;
    return Object.fromEntries(
      selected.filter((field) => field in record).map((f) => [f, record[f]]),
    );
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
