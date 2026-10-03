/**
 * The one `invalid_arguments` refusal: the executor's input parse and the
 * permission gate's command check both refuse a call this way, so the model
 * sees the same text and the app the same typed result whichever layer caught
 * the mistake. The text is rendered from the result (D8).
 */
import type { ZodError, z } from "zod";

// Type aliases, not interfaces, so both stay assignable to JsonObject.
export type InvalidArgumentIssue = {
  /** Dotted argument path such as `overrides.effort`; `arguments` for the root. */
  path: string;
  message: string;
};

export type InvalidArgumentsResult = {
  error: "invalid_arguments";
  issues: InvalidArgumentIssue[];
};

export function invalidArgumentsResult(
  issues: readonly InvalidArgumentIssue[],
): InvalidArgumentsResult {
  return { error: "invalid_arguments", issues: [...issues] };
}

/** The model's text for an `invalid_arguments` refusal. */
export function renderInvalidArguments(
  toolName: string,
  issues: readonly InvalidArgumentIssue[],
): string {
  return [
    `Invalid arguments for ${toolName}:`,
    ...issues.map(({ path, message }) => `- ${path}: ${message}`),
  ].join("\n");
}

/** Parse a tool's input, reporting the received value so issues can quote it. */
export function parseToolInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
): { ok: true; value: z.output<T> } | { ok: false; issues: InvalidArgumentIssue[] } {
  const parsed = schema.safeParse(input, { reportInput: true });
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: invalidArgumentIssues(parsed.error) };
}

export function invalidArgumentIssues(error: ZodError): InvalidArgumentIssue[] {
  return error.issues.flatMap((issue): InvalidArgumentIssue[] => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: argumentPath([...issue.path, key]),
        message: "unknown argument",
      }));
    }
    return [{ path: argumentPath(issue.path), message: issueMessage(issue) }];
  });
}

function argumentPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "arguments";
  return path.reduce<string>((joined, part) => {
    if (typeof part === "number") return `${joined}[${part}]`;
    return joined ? `${joined}.${String(part)}` : String(part);
  }, "");
}

type Issue = ZodError["issues"][number];

function issueMessage(issue: Issue): string {
  const input = (issue as { input?: unknown }).input;
  switch (issue.code) {
    case "invalid_type":
      if (input === undefined) return `required; expected ${typeName(issue.expected)}`;
      return `expected ${typeName(issue.expected)}, got ${quote(input)}`;
    case "invalid_value":
      return `expected ${oneOf(issue.values)}, got ${quote(input)}`;
    case "invalid_union": {
      const discriminator = (issue as { discriminator?: string }).discriminator;
      const options = (issue as { options?: unknown[] }).options;
      if (discriminator && options) {
        const value =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)[discriminator]
            : undefined;
        return value === undefined
          ? `required; expected ${oneOf(options)}`
          : `expected ${oneOf(options)}, got ${quote(value)}`;
      }
      return issue.message;
    }
    case "too_small":
      return sizeMessage(issue.origin, "at least", issue.minimum, issue.inclusive);
    case "too_big":
      return sizeMessage(issue.origin, "at most", issue.maximum, issue.inclusive);
    default:
      return issue.message;
  }
}

function sizeMessage(
  origin: string,
  bound: "at least" | "at most",
  limit: number | bigint,
  inclusive: boolean | undefined,
): string {
  const value = Number(limit);
  if (origin === "string") {
    if (bound === "at least" && value === 1) return "must not be empty";
    return `must be ${bound} ${value} characters`;
  }
  if (origin === "array") return `must have ${bound} ${value} items`;
  if (inclusive === false) {
    return `must be ${bound === "at least" ? "greater" : "less"} than ${value}`;
  }
  return `must be ${bound} ${value}`;
}

function typeName(expected: string): string {
  if (expected === "int") return "a whole number";
  if (expected === "object") return "an object";
  if (expected === "array") return "an array";
  return `a ${expected}`;
}

function oneOf(values: readonly unknown[]): string {
  const quoted = values.map((value) => JSON.stringify(value));
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`;
}

function quote(value: unknown): string {
  const text = value === undefined ? "nothing" : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
