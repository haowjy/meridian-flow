import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function agentRevisionId(
  pkg: { coordinate: string; contentDigest: string },
  slug: string,
  grammarVersion: string,
): string {
  const hex = sha256(
    JSON.stringify(["agent-revision", pkg.coordinate, pkg.contentDigest, slug, grammarVersion]),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
