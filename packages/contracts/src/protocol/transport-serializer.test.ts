import { describe, expect, it } from "vitest";

import { deserializeTransport, serializeTransport } from "./transport-serializer";

describe("transport serializer", () => {
  it("wraps JSON-natural domain payloads without type coercion", () => {
    const payload = {
      thread: {
        id: "thread_1",
        nextSeq: "12",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      },
    };

    const encoded = serializeTransport(payload);
    const decoded = deserializeTransport<typeof payload>(JSON.parse(JSON.stringify(encoded)));

    expect(decoded).toEqual(payload);
  });

  it("does not coerce user objects that resemble old transport tags", () => {
    const userPayload = {
      meta: { __meridianLegacyTaggedValue: { kind: "LegacyTag", payload: "2020-01-01" } },
    };

    const decoded = deserializeTransport(userPayload);
    expect(decoded.meta).toEqual(userPayload.meta);
  });
});
