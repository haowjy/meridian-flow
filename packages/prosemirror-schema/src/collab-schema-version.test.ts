/** Contract tests for collab schema version representations and compatibility algebra. */
import { describe, expect, it } from "vitest";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  clientSchemaVersionFromSubprotocolHeader,
  cmpMajorMinor,
  collabSchemaKeyTag,
  formatCollabSchemaSubprotocol,
  formatCollabSchemaVersion,
  headAdmitsClient,
  packCollabSchemaVersion,
  parseCollabSchemaVersion,
  selectCollabSchemaSubprotocol,
  serverServesHead,
  unpackCollabSchemaVersion,
} from "./index.js";

const v = (major: number, minor: number, patch: number): CollabSchemaVersion => ({
  major,
  minor,
  patch,
});

describe("collab schema version grammar", () => {
  it.each([
    v(0, 0, 0),
    v(0, 1, 0),
    v(1, 2, 3),
    v(9, 99, 999),
    v(999, 999, 999),
  ])("round-trips $major.$minor.$patch exactly", (version) => {
    expect(parseCollabSchemaVersion(formatCollabSchemaVersion(version))).toEqual(version);
  });

  it.each([
    "",
    "0",
    "0.1",
    "0.1.0.0",
    "01.2.3",
    "0.01.0",
    "0.1.00",
    "1000.0.0",
    "0.1000.0",
    "0.0.1000",
    "-1.0.0",
    "+1.0.0",
    " 0.1.0",
    "0.1.0 ",
    "0.1.0-beta",
    "meridian.collab.0.1.0",
  ])("rejects malformed version %j", (value) => {
    expect(parseCollabSchemaVersion(value)).toBeNull();
  });

  it.each([
    v(-1, 0, 0),
    v(0, -1, 0),
    v(0, 0, -1),
    v(1_000, 0, 0),
    v(0, 1_000, 0),
    v(0, 0, 1_000),
    v(0.1, 0, 0),
    v(Number.NaN, 0, 0),
  ])("refuses to format or pack invalid components %#", (version) => {
    expect(() => formatCollabSchemaVersion(version)).toThrow(RangeError);
    expect(() => packCollabSchemaVersion(version)).toThrow(RangeError);
  });
});

describe("collab schema subprotocol grammar", () => {
  it.each([
    v(0, 0, 0),
    v(0, 1, 0),
    v(1, 2, 3),
    v(999, 999, 999),
  ])("round-trips $major.$minor.$patch exactly", (version) => {
    const token = formatCollabSchemaSubprotocol(version);
    expect(clientSchemaVersionFromSubprotocolHeader(token)).toEqual(version);
    expect(selectCollabSchemaSubprotocol(token)).toBe(token);
  });

  it.each([
    "meridian.collab.4",
    "meridian.collab.0.1",
    "meridian.collab.01.2.3",
    "0.1.0",
    "meridian.collab.0.1.0-beta",
    "meridian.collab.1000.1.0",
    "Meridian.collab.0.1.0",
  ])("rejects N6/malformed token %j", (token) => {
    expect(clientSchemaVersionFromSubprotocolHeader(token)).toEqual(v(0, 0, 0));
    expect(selectCollabSchemaSubprotocol(token)).toBe(token);
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
    [null, "absent"],
    ["", "empty"],
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
    ["unrelated.v1, another", "zero matches"],
    ["unrelated.v1, meridian.collab.0.1.0, meridian.collab.0.2.0", "multiple matches"],
  ])("echoes the first offered token for %s (%s)", (header, _case) => {
    expect(selectCollabSchemaSubprotocol(header)).toBe("unrelated.v1");
  });

  it.each([null, "", "   "])("echoes nothing when no token is offered in %j", (header) => {
    expect(selectCollabSchemaSubprotocol(header)).toBeUndefined();
  });
});

describe("packed collab schema versions", () => {
  it.each([
    [v(0, 1, 0), 1_000],
    [v(1, 2, 3), 1_002_003],
    [v(999, 999, 999), 999_999_999],
  ] as const)("packs and unpacks %# as %i", (version, packed) => {
    expect(packCollabSchemaVersion(version)).toBe(packed);
    expect(unpackCollabSchemaVersion(packed)).toEqual(version);
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1_000_000_000,
  ])("rejects invalid packed value %s", (packed) => {
    expect(() => unpackCollabSchemaVersion(packed)).toThrow(RangeError);
  });

  it("preserves version ordering over the component range", () => {
    const ordered = [v(0, 1, 999), v(0, 2, 0), v(1, 0, 0), v(1, 0, 1)];
    expect(ordered.map(packCollabSchemaVersion)).toEqual([1_999, 2_000, 1_000_000, 1_000_001]);
  });
});

describe("collab schema compatibility algebra", () => {
  it("compares only major and minor", () => {
    expect(cmpMajorMinor(v(0, 1, 999), v(0, 1, 0))).toBe(0);
    expect(cmpMajorMinor(v(0, 2, 0), v(0, 1, 999))).toBeGreaterThan(0);
    expect(cmpMajorMinor(v(1, 0, 0), v(0, 999, 999))).toBeGreaterThan(0);
  });

  it.each([
    [v(0, 1, 0), v(0, 2, 0), true],
    [v(0, 2, 0), v(0, 1, 0), true],
    [v(0, 1, 0), v(1, 0, 0), false],
    [v(1, 0, 0), v(0, 1, 0), false],
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

  it("uses major.minor for client state keys", () => {
    expect(collabSchemaKeyTag()).toBe("v0.1");
    expect(collabSchemaKeyTag(v(2, 3, 999))).toBe("v2.3");
    expect(COLLAB_SCHEMA_VERSION).toEqual(v(0, 1, 0));
  });
});
