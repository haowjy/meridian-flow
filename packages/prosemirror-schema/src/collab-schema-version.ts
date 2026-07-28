/** Canonical version grammar, storage encoding, compatibility algebra, and key tag. */

export type CollabSchemaVersion = {
  major: number;
  minor: number;
  patch: number;
};

export const COLLAB_SCHEMA_VERSION: CollabSchemaVersion = {
  major: 0,
  minor: 1,
  patch: 0,
};

const VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const SUBPROTOCOL_PREFIX = "meridian.collab.";
const COMPONENT_BASE = 1_000;
const MAX_COMPONENT = COMPONENT_BASE - 1;
const MINOR_MULTIPLIER = COMPONENT_BASE;
const MAJOR_MULTIPLIER = COMPONENT_BASE ** 2;
const MAX_PACKED_VERSION = COMPONENT_BASE ** 3 - 1;
const UNKNOWN_VERSION: CollabSchemaVersion = { major: 0, minor: 0, patch: 0 };

function assertComponent(component: number, name: keyof CollabSchemaVersion): void {
  if (!Number.isInteger(component) || component < 0 || component > MAX_COMPONENT) {
    throw new RangeError(
      `Collab schema ${name} must be an integer from 0 through ${MAX_COMPONENT}`,
    );
  }
}

function assertVersion(version: CollabSchemaVersion): void {
  assertComponent(version.major, "major");
  assertComponent(version.minor, "minor");
  assertComponent(version.patch, "patch");
}

function versionFromMatch(match: RegExpMatchArray): CollabSchemaVersion {
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function formatCollabSchemaVersion(version: CollabSchemaVersion): string {
  assertVersion(version);
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function parseCollabSchemaVersion(value: string): CollabSchemaVersion | null {
  const match = value.match(VERSION);
  return match ? versionFromMatch(match) : null;
}

export function packCollabSchemaVersion(version: CollabSchemaVersion): number {
  assertVersion(version);
  return version.major * MAJOR_MULTIPLIER + version.minor * MINOR_MULTIPLIER + version.patch;
}

export function unpackCollabSchemaVersion(packed: number): CollabSchemaVersion {
  if (!Number.isInteger(packed) || packed < 0 || packed > MAX_PACKED_VERSION) {
    throw new RangeError(
      `Packed collab schema version must be an integer from 0 through ${MAX_PACKED_VERSION}`,
    );
  }
  return {
    major: Math.floor(packed / MAJOR_MULTIPLIER),
    minor: Math.floor((packed % MAJOR_MULTIPLIER) / MINOR_MULTIPLIER),
    patch: packed % MINOR_MULTIPLIER,
  };
}

export function formatCollabSchemaSubprotocol(version: CollabSchemaVersion): string {
  return `${SUBPROTOCOL_PREFIX}${formatCollabSchemaVersion(version)}`;
}

function parseCollabSchemaSubprotocol(token: string): CollabSchemaVersion | null {
  if (!token.startsWith(SUBPROTOCOL_PREFIX)) return null;
  return parseCollabSchemaVersion(token.slice(SUBPROTOCOL_PREFIX.length));
}

function offeredSubprotocols(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function matchingSubprotocols(
  offered: string[],
): Array<{ token: string; version: CollabSchemaVersion }> {
  return offered.flatMap((token) => {
    const version = parseCollabSchemaSubprotocol(token);
    return version ? [{ token, version }] : [];
  });
}

export function clientSchemaVersionFromSubprotocolHeader(
  header: string | null,
): CollabSchemaVersion {
  const matches = matchingSubprotocols(offeredSubprotocols(header));
  return matches.length === 1 ? matches[0].version : UNKNOWN_VERSION;
}

export function selectCollabSchemaSubprotocol(header: string | null): string | undefined {
  const offered = offeredSubprotocols(header);
  if (offered.length === 0) return undefined;
  const matches = matchingSubprotocols(offered);
  return matches.length === 1 ? matches[0].token : offered[0];
}

export function cmpMajorMinor(a: CollabSchemaVersion, b: CollabSchemaVersion): number {
  return a.major - b.major || a.minor - b.minor;
}

export function serverServesHead(head: CollabSchemaVersion, server: CollabSchemaVersion): boolean {
  return head.major === server.major;
}

export function headAdmitsClient(client: CollabSchemaVersion, head: CollabSchemaVersion): boolean {
  return cmpMajorMinor(client, head) >= 0;
}

export function collabSchemaKeyTag(version = COLLAB_SCHEMA_VERSION): string {
  assertVersion(version);
  return `v${version.major}.${version.minor}`;
}
