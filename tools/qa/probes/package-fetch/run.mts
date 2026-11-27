/**
 * The package fetch port's shared budgets: each aborts with its own name when its limit is
 * lowered, and the tar reader counts bytes as they stream (a 4 MB repository trips a 1 MB expanded
 * limit without reading the rest). GitHub is an in-process fake serving a generated repository, so
 * the probe makes no network calls; `./mf package fetch <url>` reads live GitHub. The fake's body
 * ignores the abort signal, so a download that stalls with no chunks arriving is checked only live.
 *
 *   pnpm exec tsx tools/qa/probes/package-fetch/run.mts
 *
 * Pins implementation decisions: the budget names `download`, `expanded`, `entries`, `wall-time`.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import {
  createFetchBudget,
  createGithubPackageFetcher,
  FETCH_LIMITS,
  FetchBudgetError,
  type FetchLimits,
} from "../../../../apps/server/server/domains/packages/index.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const url = "https://github.com/example/pack";
const FILES = 200;
const FILE_BYTES = 20_000;

/** One ustar header block; GitHub wraps every entry in `<owner>-<repo>-<shortsha>/`. */
function header(name: string, size: number, type: "0" | "5"): Buffer {
  const block = Buffer.alloc(512);
  const field = (value: string, offset: number, length: number) =>
    block.write(value, offset, length, "ascii");
  field(name, 0, 100);
  field("0000644\0", 100, 8);
  field("0000000\0", 108, 8);
  field("0000000\0", 116, 8);
  field(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  field("00000000000\0", 136, 12);
  field("        ", 148, 8);
  field(type, 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  const sum = block.reduce((total, byte) => total + byte, 0);
  field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

const root = `pack-${sha}/`;
const parts: Buffer[] = [header(root, 0, "5")];
for (let index = 0; index < FILES; index += 1) {
  // Random bytes, so gzip can't shrink the download below the expanded size.
  const body = randomBytes(FILE_BYTES);
  parts.push(header(`${root}skills/s${index}.md`, body.length, "0"), body);
  parts.push(Buffer.alloc((512 - (body.length % 512)) % 512));
}
parts.push(Buffer.alloc(1024));
const tarball = gzipSync(Buffer.concat(parts));

const fakeGithub: typeof fetch = async (input, init) => {
  await sleep(5);
  if (init?.signal?.aborted) throw init.signal.reason;
  const target = String(input);
  if (target === "https://api.github.com/repos/example/pack/commits/HEAD") {
    return Response.json({ sha });
  }
  if (target === `https://codeload.github.com/example/pack/tar.gz/${sha}`) {
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= tarball.length) return controller.close();
        controller.enqueue(tarball.subarray(offset, offset + 65_536));
        offset += 65_536;
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-gzip" } });
  }
  return new Response("not found", { status: 404 });
};

const fetcher = createGithubPackageFetcher({ fetch: fakeGithub });

const whole = await fetcher.fetchTree({ url }, createFetchBudget());
assert.equal(whole.commit, sha);
assert.equal(Object.keys(whole.files).length, FILES);
console.log(`unlimited: ${FILES} files at ${sha.slice(0, 7)}`);

function tickingClock(): () => number {
  let ms = 0;
  return () => {
    ms += 1000;
    return ms;
  };
}

const trips: [string, Partial<FetchLimits>][] = [
  ["download", { downloadBytes: 100_000 }],
  ["expanded", { expandedBytes: 1_000_000 }],
  ["entries", { entries: 100 }],
  ["wall-time", {}],
];

for (const [name, limits] of trips) {
  const budget = createFetchBudget(
    { ...FETCH_LIMITS, ...limits },
    name === "wall-time" ? tickingClock() : Date.now,
  );
  const error = await fetcher.fetchTree({ url }, budget).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof FetchBudgetError, `${name}: expected a budget error, got ${error}`);
  assert.equal(error.budget, name);
  const used = budget.used();
  assert.ok(used.downloadBytes > 0, `${name}: tripped before the download started`);
  assert.ok(used.downloadBytes < tarball.length, `${name}: read the whole archive first`);
  console.log(`${name}: ${error.message}`, used);
}
