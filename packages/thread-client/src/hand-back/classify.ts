export type HttpResult = { status: number; body: unknown } | { status: null };

export type HttpPort = (path: string, body: unknown) => Promise<HttpResult>;

export type ResponseSchema<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
};

export type FrozenRequest = { path: string; body: unknown };

export type Verdict<T> =
  | { kind: "confirmed"; answer: T }
  | { kind: "refused"; status: number }
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

export async function postFrozen(http: HttpPort, request: FrozenRequest): Promise<HttpResult> {
  try {
    return await http(request.path, request.body);
  } catch {
    return { status: null };
  }
}
