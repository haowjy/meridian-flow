/** Contract tests for collab schema version representations and compatibility algebra. */
import { describe, expect, it } from "vitest";
import {
  type CollabSchemaVersion,
  clientSchemaVersionFromSubprotocolHeader,
  headAdmitsClient,
  parseCollabSchemaVersion,
  selectCollabSchemaSubprotocol,
  serverServesHead,
} from "./index.js";

const v = (major: number, minor: number, patch: number): CollabSchemaVersion => ({
  major,
  minor,
  patch,
});

describe("collab schema version grammar", () => {
  it.each([
    "01.2.3",
    "1000.0.0",
    "meridian.collab.0.1.0",
  ])("rejects malformed version %j", (value) => {
    expect(parseCollabSchemaVersion(value)).toBeNull();
  });
});

describe("collab schema subprotocol offers", () => {
  const sentinel = v(0, 0, 0);

  it("resolves exactly one matching token from an ordered offer list", () => {
    expect(
      clientSchemaVersionFromSubprotocolHeader("unrelated.v1, meridian.collab.12.34.56, another"),
    ).toEqual(v(12, 34, 56));
  });

  it.each([
    ["unrelated.v1, another", "zero matches"],
    ["meridian.collab.0.1.0, meridian.collab.0.2.0", "multiple matches"],
  ])("maps an %s header (%s) to the sentinel", (header, _case) => {
    expect(clientSchemaVersionFromSubprotocolHeader(header)).toEqual(sentinel);
  });

  it("echoes the sole matching token even when it is not first", () => {
    expect(selectCollabSchemaSubprotocol("unrelated.v1, meridian.collab.0.1.0, another")).toBe(
      "meridian.collab.0.1.0",
    );
  });

  it.each([
    ["unrelated.v1, meridian.collab.0.1.0, meridian.collab.0.2.0", "multiple matches"],
  ])("echoes the first offered token for %s (%s)", (header, _case) => {
    expect(selectCollabSchemaSubprotocol(header)).toBe("unrelated.v1");
  });

  it.each([null])("echoes nothing when no token is offered in %j", (header) => {
    expect(selectCollabSchemaSubprotocol(header)).toBeUndefined();
  });
});

describe("collab schema compatibility algebra", () => {
  it.each([
    [v(0, 1, 0), v(0, 2, 0), true],
    [v(0, 1, 0), v(1, 0, 0), false],
  ] as const)("serves a head exactly when majors match", (head, server, admitted) => {
    expect(serverServesHead(head, server)).toBe(admitted);
  });

  it.each([
    [v(0, 1, 0), v(0, 1, 999), true],
    [v(0, 2, 0), v(0, 1, 999), true],
    [v(0, 1, 999), v(0, 2, 0), false],
    [v(1, 0, 0), v(0, 999, 999), true],
  ] as const)("admits clients at or above the head major/minor", (client, head, admitted) => {
    expect(headAdmitsClient(client, head)).toBe(admitted);
  });
});
