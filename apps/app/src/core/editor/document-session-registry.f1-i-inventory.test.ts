/** Exact production negative-space inventory for document-session authority. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Finding = Readonly<{ file: string; line: number; text: string }>;

const SOURCE_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OMIT = /(?:\.test(?:-data|-support)?|\.typecheck|\.generated|\.gen)\.tsx?$/;

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : productionFiles(path);
    return /\.tsx?$/.test(entry.name) && !OMIT.test(entry.name) ? [path] : [];
  });
}

function scan(pattern: RegExp): Finding[] {
  return productionFiles(SOURCE_ROOT).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((text, index) =>
        pattern.test(text)
          ? [{ file: relative(SOURCE_ROOT, file), line: index + 1, text: text.trim() }]
          : [],
      ),
  );
}

describe("F1-J document-session production inventory", () => {
  it.each([
    ["facade", /\b(?:TemporaryUnfencedDocumentSessionRegistry|getDocumentSessionRegistry)\b/],
    ["temporary members", /\btemporary[A-Z][A-Za-z0-9_]*\b/],
    ["deleted aliases", /\b(?:revokeRoom|destroyRoom)\b/],
    ["unqualified persistence helper", /\broomSessionPersistenceKey\b/],
    ["legacy IndexedDB scanner", /\bdeleteStaleVersionedIndexedDb\b/],
    ["canonical IndexedDB enumeration", /indexedDB\.databases\s*\(/],
    ["adoption staging", /\bstageIndexedDbPersistence\b/],
    ["adoption provider replacement", /\bpreviousPersistenceName\b/],
    ["document-keyed Untitled record", /\bLocalUntitledRecord\b/],
    ["v2 Untitled storage", /pending-untitled:v2/],
    ["fake Untitled lifecycle", /\bUntitledLifecycleRig\b/],
    ["byte acknowledgement", /\b(?:byteAck|byteLease|pendingPersistenceDeletion)\b/],
  ] as const)("keeps %s at exact zero", (_name, pattern) => {
    expect(scan(pattern)).toEqual([]);
  });

  it.each([
    ["module-global registry", /\bsharedRegistry\b/],
    ["module-global getter", /\bgetLiveDocumentSessionRegistry\b/],
    ["render-time account configurator", /\bconfigureDocumentSessionUser\b/],
  ] as const)("keeps %s at exact zero", (_name, pattern) => {
    expect(scan(pattern)).toEqual([]);
  });

  it("keeps mutable registry lifecycle methods at exact zero", () => {
    const findings = [
      ...scan(/^\s*setOwnUserId\s*\(/),
      ...scan(/^\s*destroyAll\s*\(\)\s*:\s*void/),
    ].filter(({ file }) => file === "core/editor/document-session-registry-implementation.ts");
    expect(findings).toEqual([]);
  });

  it("constructs exactly one production registry at the immutable account runtime", () => {
    expect(scan(/\bnew DocumentSessionRegistry\s*\(/)).toEqual([
      expect.objectContaining({ file: "core/editor/account-document-session-runtime.ts" }),
    ]);
  });
});
