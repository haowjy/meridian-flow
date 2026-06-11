import { z } from "zod";

export type YjsTrackedSchemaType = "document" | "code";

const documentIdSchema = z.string().min(1);
const channelIndexSchema = z.number().int().nonnegative().safe();

export const yjsSubscribeControlFrameSchema = z.object({
  type: z.literal("subscribe"),
  documentId: documentIdSchema,
});

export const yjsUnsubscribeControlFrameSchema = z.object({
  type: z.literal("unsubscribe"),
  documentId: documentIdSchema,
});

export const yjsClientControlFrameSchema = z.discriminatedUnion("type", [
  yjsSubscribeControlFrameSchema,
  yjsUnsubscribeControlFrameSchema,
]);

export type YjsClientControlFrame = z.infer<typeof yjsClientControlFrameSchema>;

export const yjsControlErrorCodeSchema = z.enum([
  "auth_failed",
  "document_not_found",
  "forbidden",
  "not_subscribed",
  "bad_request",
  "internal",
]);

export type YjsControlErrorCode = z.infer<typeof yjsControlErrorCodeSchema>;

export const yjsSubscribedControlFrameSchema = z.object({
  type: z.literal("subscribed"),
  documentId: documentIdSchema,
  channelIndex: channelIndexSchema,
});

export const yjsErrorControlFrameSchema = z.object({
  type: z.literal("error"),
  code: yjsControlErrorCodeSchema,
  reason: z.string(),
  documentId: documentIdSchema.optional(),
  channelIndex: channelIndexSchema.optional(),
});

export const yjsServerControlFrameSchema = z.discriminatedUnion("type", [
  yjsSubscribedControlFrameSchema,
  yjsErrorControlFrameSchema,
]);

export type YjsServerControlFrame = z.infer<typeof yjsServerControlFrameSchema>;
export type YjsControlFrame = YjsClientControlFrame | YjsServerControlFrame;

function parseMessage<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseYjsClientControlFrame(raw: string): YjsClientControlFrame | null {
  return parseMessage(raw, yjsClientControlFrameSchema);
}

export function parseYjsServerControlFrame(raw: string): YjsServerControlFrame | null {
  return parseMessage(raw, yjsServerControlFrameSchema);
}

export function encodeYjsControlFrame(message: YjsControlFrame): string {
  return JSON.stringify(message);
}

export type YjsBinaryEnvelope = {
  channelIndex: number;
  payload: Uint8Array;
};

export function encodeYjsBinaryEnvelope(channelIndex: number, payload: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(channelIndex) || channelIndex < 0) {
    throw new RangeError("channelIndex must be a non-negative safe integer");
  }

  const prefix: number[] = [];
  let value = channelIndex;
  while (value > 0x7f) {
    prefix.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  prefix.push(value);

  const frame = new Uint8Array(prefix.length + payload.byteLength);
  frame.set(prefix, 0);
  frame.set(payload, prefix.length);
  return frame;
}

export function decodeYjsBinaryEnvelope(frame: Uint8Array): YjsBinaryEnvelope | null {
  let channelIndex = 0;
  let shift = 0;

  for (let offset = 0; offset < frame.byteLength; offset += 1) {
    const byte = frame[offset];
    channelIndex += (byte & 0x7f) * 2 ** shift;
    if (!Number.isSafeInteger(channelIndex)) return null;

    if (byte < 0x80) {
      return {
        channelIndex,
        payload: frame.subarray(offset + 1),
      };
    }

    shift += 7;
    if (shift > 49) return null;
  }

  return null;
}
