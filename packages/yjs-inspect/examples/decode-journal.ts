/**
 * Summarize Yjs journal update rows without reconstructing manuscript content.
 *
 * File: pnpm tsx packages/yjs-inspect/examples/decode-journal.ts updates.txt
 * Stdin: cat updates.txt | pnpm tsx packages/yjs-inspect/examples/decode-journal.ts
 * Database:
 * psql "$DATABASE_URL" -X -A -t -c "SELECT encode(update_data, 'hex') FROM document_yjs_updates WHERE document_id = '<document-id>' ORDER BY id, batch_ordinal" | pnpm tsx packages/yjs-inspect/examples/decode-journal.ts
 *
 * Input may be one hex row per line, `sequence<TAB>hex`, psql expanded output
 * containing `update_hex | ...`, or an explicit `base64:<data>` row.
 */

import { readFile } from "node:fs/promises";
import { summarizeUpdate } from "../src/index.js";

function decodeRow(line: string): Uint8Array | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const expandedHex = trimmed.match(/^update_hex\s*\|\s*([0-9a-f]+)$/i)?.[1];
  const tabularHex = trimmed.match(/^\d+\s+([0-9a-f]+)$/i)?.[1];
  const prefixedHex = trimmed.match(/^hex:([0-9a-f]+)$/i)?.[1];
  const bareHex = trimmed.match(/^[0-9a-f]+$/i)?.[0];
  const hex = expandedHex ?? tabularHex ?? prefixedHex ?? bareHex;
  if (hex) {
    if (hex.length % 2 !== 0) throw new Error(`Odd-length hex row: ${trimmed}`);
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }

  const base64 = trimmed.match(/^base64:([A-Za-z0-9+/]+={0,2})$/)?.[1];
  return base64 ? Uint8Array.from(Buffer.from(base64, "base64")) : null;
}

const file = process.argv[2];
const input = file
  ? await readFile(file, "utf8")
  : await new Promise<string>((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    });

const rows = input
  .split(/\r?\n/)
  .map(decodeRow)
  .filter((row): row is Uint8Array => row !== null);
if (rows.length === 0) throw new Error("No hex or base64 update rows found");

let totalBytes = 0;
let totalStructs = 0;
let totalDeletes = 0;
let noopRows = 0;

rows.forEach((row, index) => {
  const summary = summarizeUpdate(row);
  totalBytes += summary.bytes;
  totalStructs += summary.structCount;
  totalDeletes += summary.deleteSetSize;
  if (summary.isNoop) noopRows += 1;
  const clients = summary.clients
    .map(({ client, clockFrom, clockTo }) => `${client}:${clockFrom}-${clockTo}`)
    .join(",");
  console.log(
    `row=${index + 1} bytes=${summary.bytes} structs=${summary.structCount} deletes=${summary.deleteSetSize} noop=${summary.isNoop} clients=${clients || "-"} hash=${summary.updateHash}`,
  );
});

console.log(
  `totals rows=${rows.length} bytes=${totalBytes} structs=${totalStructs} deletes=${totalDeletes} noops=${noopRows}`,
);
