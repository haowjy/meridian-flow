import { describe, expect, it } from "vitest";
import {
  decodeYjsBinaryEnvelope,
  encodeYjsBinaryEnvelope,
  schemaTypeForLanguage,
} from "./yjs-multiplex";

describe("schemaTypeForLanguage", () => {
  it("derives the schema family from the stored language string", () => {
    expect(schemaTypeForLanguage("markdown")).toBe("document");
    expect(schemaTypeForLanguage("python")).toBe("code");
    expect(schemaTypeForLanguage("anything-else")).toBe("code");
  });
});

describe("Yjs multiplex binary envelope", () => {
  it("round-trips a channel index and payload", () => {
    const payload = new Uint8Array([0, 1, 2, 3]);
    const frame = encodeYjsBinaryEnvelope(7, payload);

    const decoded = decodeYjsBinaryEnvelope(frame);

    expect(decoded?.channelIndex).toBe(7);
    expect(Array.from(decoded?.payload ?? [])).toEqual([0, 1, 2, 3]);
  });

  it("uses a varuint channel prefix", () => {
    const frame = encodeYjsBinaryEnvelope(300, new Uint8Array([42]));

    expect(Array.from(frame)).toEqual([0xac, 0x02, 42]);
    expect(decodeYjsBinaryEnvelope(frame)).toMatchObject({
      channelIndex: 300,
      payload: new Uint8Array([42]),
    });
  });

  it("decodes the payload as a view over the original frame", () => {
    const frame = encodeYjsBinaryEnvelope(1, new Uint8Array([9, 8, 7]));
    const decoded = decodeYjsBinaryEnvelope(frame);

    expect(decoded?.payload.buffer).toBe(frame.buffer);
    expect(decoded?.payload.byteOffset).toBe(frame.byteOffset + 1);
  });

  it("rejects a truncated varuint prefix", () => {
    expect(decodeYjsBinaryEnvelope(new Uint8Array([0x80]))).toBeNull();
  });
});
