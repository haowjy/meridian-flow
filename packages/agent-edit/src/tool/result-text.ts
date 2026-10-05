// The one renderer from a `read` or `write` result to the text the model sees (D43).
//
// Hosts keep the typed result beside this text; nothing parses the text back.
import { splitDocumentFile } from "../document-address.js";
import { toHashline } from "../model/hashline.js";
import type {
  AgentEditBlockGroup,
  AgentEditBlockItem,
  AgentEditConcurrentRun,
  AgentEditResultV1,
} from "./model-result.js";

/**
 * The `read` call that targets one path, in the form results print for the
 * model. A live read's follow-ups stay live; the default needs no `version`.
 */
export function readCall(path: string, version?: "draft" | "live"): string {
  const versionArg = version === "live" ? `, "version": "live"` : "";
  return `read({"path": ${JSON.stringify(path)}${versionArg}})`;
}

/**
 * Renders one status line, any notes (concurrent edits, sweeps, the message),
 * then the blocks as `hash|text` lines. An outline says once how to read a
 * section, and each heading carries its `#slug`.
 */
export function renderAgentEditResult(result: AgentEditResultV1): string {
  const groups = result.blocks ?? [];
  const sections = [[statusLine(result), ...notes(result, groups)].join("\n")];
  if (result.message) sections.push(result.message);
  const outline = outlineFile(result);
  if (outline) {
    sections.push(`Read a section with ${readCall(`${outline}#<slug>`, result.read?.version)}.`);
  }
  const body = bodyLines(result, groups, outline);
  if (body.length > 0) sections.push(body.join("\n"));
  return sections.join("\n\n");
}

function statusLine(result: AgentEditResultV1): string {
  const facts = [`status: ${result.status}`];
  if (result.reason) facts.push(`reason: ${result.reason}`);
  if (result.path) facts.push(`path: ${result.path}`);
  if (result.write?.id) facts.push(`write: ${result.write.id}`);
  const version = writeVersion(result);
  if (version) facts.push(`version: ${version}`);
  if (result.copied) {
    const count = result.copied.blocks;
    facts.push(
      count === undefined
        ? `copied from ${result.copied.from}`
        : `copied: ${blockCount(count)} from ${result.copied.from}`,
    );
  }
  if (result.reversal && result.reversal.writes.length > 0) {
    facts.push(`${result.reversal.direction}: ${result.reversal.writes.join(", ")}`);
  }
  if (result.read) {
    const count = documentItems(result.blocks ?? []).length;
    const total = result.read.documentBlocks;
    facts.push(
      total !== undefined && total > count ? `blocks: ${count} of ${total}` : `blocks: ${count}`,
    );
    if (result.read.version) facts.push(`version: ${result.read.version}`);
    if (result.read.format === "outline") facts.push("format: outline");
  }
  return facts.join("; ");
}

function blockCount(count: number): string {
  return count === 1 ? "1 block" : `${count} blocks`;
}

/**
 * A finished call's result in brief, for one history line (D48): the status
 * when it isn't plain success, the write handle, `words` (the size of the
 * content the call sent, which only the host has), the draft it changed, what it
 * copied or reversed, and a read's block count.
 */
export function agentEditResultSummary(result: AgentEditResultV1, words?: number): string {
  const facts: string[] = [];
  if (result.status !== "success" && result.status !== "reversed") facts.push(result.status);
  if (result.write?.id) facts.push(result.write.id);
  if (words !== undefined)
    facts.push(`${words.toLocaleString("en-US")} ${words === 1 ? "word" : "words"}`);
  if (result.destination === "draft" && result.draftWork !== undefined)
    facts.push(`version: ${writeVersion(result)}`);
  if (result.copied?.blocks !== undefined) facts.push(`copied ${blockCount(result.copied.blocks)}`);
  if (result.reversal && result.reversal.writes.length > 0)
    facts.push(`${result.reversal.direction}: ${result.reversal.writes.join(", ")}`);
  if (result.read) {
    const count = documentItems(result.blocks ?? []).length;
    const total = result.read.documentBlocks;
    facts.push(
      total !== undefined && total > count ? `${count} of ${total} blocks` : blockCount(count),
    );
  }
  return facts.join(", ");
}

/**
 * The version a write changed, in `read`'s terms (D50): `live`, or `draft
 * (@work)` for a write held in a Work's draft. Undo and redo name none.
 */
function writeVersion(result: Pick<AgentEditResultV1, "destination" | "draftWork">): string {
  if (result.destination === "draft" && result.draftWork !== undefined)
    return `draft (@${result.draftWork})`;
  return result.destination === "live" ? "live" : "";
}

function notes(result: AgentEditResultV1, groups: readonly AgentEditBlockGroup[]): string[] {
  const lines: string[] = [];
  const removed = result.write?.deletedHashes ?? [];
  if (removed.length > 0) lines.push(`removed: ${removed.join(", ")}`);
  if (result.status === "reconciled") {
    lines.push("later edits were kept, so the text may not match how it was before the write.");
  }
  if (result.documentEmpty) lines.push("document is now empty; its one blank block always stays.");
  if (result.concurrent) {
    const shown = new Set(
      groups
        .filter((group) => group.extent === "full" && group.relation === "changed")
        .flatMap((group) => group.items.map((item) => item.hash)),
    );
    lines.push(...concurrentLines(result.concurrent.runs, shown));
    if (result.concurrent.syncOverflow) lines.push("sync_overflow: fresh bounded read required");
  }
  const swept = groups.filter((group) => group.relation === "swept");
  if (swept.length > 0) {
    lines.push("concurrent user content swept during commit; re-read required");
    for (const item of swept.flatMap((group) => group.items)) {
      lines.push(`swept: ${blockLine(item)}`);
    }
  }
  if (result.awarenessDegraded) {
    lines.push("destructive awareness degraded after durable recovery; re-read required");
  }
  return lines;
}

function concurrentLines(
  runs: readonly AgentEditConcurrentRun[],
  shown: ReadonlySet<string>,
): string[] {
  const rendered: string[] = [];
  for (const run of runs) {
    const entries = [
      ...run.blocks.filter((item) => !shown.has(item.hash)).map((item) => `    ${blockLine(item)}`),
      ...run.tombstones.map(
        (tombstone) => `    ${tombstone.hash}| [explicit deletion]\n${tombstone.body}`,
      ),
    ];
    if (entries.length > 0) rendered.push(`  ${run.origin}:`, ...entries);
  }
  return rendered.length > 0 ? ["concurrent edits:", ...rendered] : [];
}

/** The file an outline's sections are read from; undefined when the result isn't an outline. */
function outlineFile(result: AgentEditResultV1): string | undefined {
  if (result.read?.format !== "outline" || !result.path) return undefined;
  return splitDocumentFile(result.path).filePath;
}

function bodyLines(
  result: AgentEditResultV1,
  groups: readonly AgentEditBlockGroup[],
  outline: string | undefined,
): string[] {
  const items = groups
    .filter((group) => group.relation !== "swept")
    .flatMap((group) => group.items);
  if (!outline) return items.map(blockLine);
  // A heading whose slug looks like a hash is read by its hash.
  return items.map((item) => `${blockLine(item)}  #${item.section ?? item.hash}`);
}

function documentItems(groups: readonly AgentEditBlockGroup[]): AgentEditBlockItem[] {
  return groups.filter((group) => group.relation === "document").flatMap((group) => group.items);
}

function blockLine(item: AgentEditBlockItem): string {
  return toHashline(item.hash, item.body);
}
