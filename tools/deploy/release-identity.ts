/** Canonical release tag, image, service, and deploy-tool identity. */
export const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;
export type ReleaseTag = {
  tag: string;
  major: number;
  minor: number;
  patch: number;
  rc: number | null;
};

export function parseTag(tag: string): ReleaseTag | null {
  const match = TAG_RE.exec(tag);
  if (!match) return null;
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: match[4] === undefined ? null : Number(match[4]),
  };
}

export function releaseSubject(tag: string): string {
  if (!parseTag(tag)) throw new Error(`Invalid release tag '${tag}'`);
  return `release: ${tag}`;
}

export const SERVICES = ["server", "app", "www", "ingress"] as const;
export type Service = (typeof SERVICES)[number];
export function imageRepository(service: Service): string {
  return `ghcr.io/haowjy/meridian-flow-${service}`;
}
export const RAILWAY_CLI_VERSION = "5.62.1";

function main() {
  const [command, value] = process.argv.slice(2);
  if (command === "services") return console.log(SERVICES.join(" "));
  if (command === "image-repository" && SERVICES.includes(value as Service))
    return console.log(imageRepository(value as Service));
  if (command === "railway-version") return console.log(RAILWAY_CLI_VERSION);
  if (command === "release-subject" && value) return console.log(releaseSubject(value));
  throw new Error(
    "Usage: release-identity.ts services | image-repository <service> | railway-version | release-subject <tag>",
  );
}
if (process.argv[1]?.endsWith("release-identity.ts")) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
