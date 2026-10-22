/**
 * The answer classifier shared by every command that posts and reads a whole record back
 * (hand-back, Stop, Send now). The HTTP port returns a status and a decoded body; this decides
 * what that means before any state-changing port is touched.
 */

/** What an HTTP port returns: the status and decoded JSON, or `status: null` when no answer came. */
export type HttpResult = { status: number; body: unknown } | { status: null };

/** The HTTP port: never throws a typed error; a transport failure is `{ status: null }`. */
export type HttpPort = (path: string, body: unknown) => Promise<HttpResult>;

/** A response schema, structurally: anything with `safeParse` (the contracts' zod schemas). */
export type ResponseSchema<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
};

/** The request a command posted, frozen so an ambiguous outcome can be replayed byte for byte. */
export type FrozenRequest = { path: string; body: unknown };

export type Verdict<T> =
  /** A 2xx whose body the schema accepts in full. */
  | { kind: "confirmed"; answer: T }
  /** A definite 400, 404 or 409: a replay would be refused again. */
  | { kind: "refused"; status: number }
  /** No answer, a 5xx, or a 2xx that does not validate: the server may or may not have acted. */
  | { kind: "ambiguous" };

const DEFINITE_REFUSALS = new Set([400, 404, 409]);

export function classifyAnswer<T>(result: HttpResult, schema: ResponseSchema<T>): Verdict<T> {
  const { status } = result;
  if (status === null) return { kind: "ambiguous" };
  if (status >= 200 && status < 300) {
    const parsed = schema.safeParse((result as { body: unknown }).body);
    return parsed.success ? { kind: "confirmed", answer: parsed.data } : { kind: "ambiguous" };
  }
  return DEFINITE_REFUSALS.has(status) ? { kind: "refused", status } : { kind: "ambiguous" };
}

/** Run the HTTP port; a port that throws is a lost answer. */
export async function postFrozen(http: HttpPort, request: FrozenRequest): Promise<HttpResult> {
  try {
    return await http(request.path, request.body);
  } catch {
    return { status: null };
  }
}
