// The one renderer from a `read` or `write` result to the text the model sees (D43).
//
// Hosts keep the typed result beside this text; nothing parses the text back.
import { splitDocumentFile } from "../document-address.js";
import { toHashline } from "../model/hashline.js";
import type {
  AgentEditBlockGroup,
  AgentEditBlockItem,
  AgentEditConcurrentListing,
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
 * Renders one status line, any notes and the message, then the blocks as
 * `hash|text` lines and the concurrent-edit account. An outline says once how
 * to read a section, and each heading carries its `#slug`.
 */
export function renderAgentEditResult(result: AgentEditResultV1): string {
  const groups = result.blocks ?? [];
  const sections = [
    [
      ...(result.notice ? [result.notice] : []),
      ...pendingLine(result),
      statusLine(result),
      ...notes(result),
    ].join("\n"),
  ];
  if (result.message) sections.push(result.message);
  const outline = outlineFile(result);
  if (outline) {
    sections.push(`Read a section with ${readCall(`${outline}#<slug>`, result.read?.version)}.`);
  }
  const body = bodyLines(groups, outline);
  if (body.length > 0) sections.push(body.join("\n"));
  if (result.concurrent) sections.push(concurrentLines(result.concurrent).join("\n"));
  return sections.join("\n\n");
}

function statusLine(result: AgentEditResultV1): string {
  const facts = [`status: ${result.status}`];
  if (result.reason) facts.push(`reason: ${result.reason}`);
  if (result.path) facts.push(`path: ${result.path}${result.owner ? ` (${result.owner})` : ""}`);
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
  if (result.namespace)
    facts.push(
      result.namespace.kind === "moved" ? `moved from ${result.namespace.from}` : "deleted",
    );
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

/**
 * A drafted move or delete is pending until the user applies it: said first, before the status
 * a model otherwise reads as done, and in terms of live, which every area shares.
 */
function pendingLine(result: AgentEditResultV1): string[] {
  const change = result.namespace;
  if (!change || result.destination !== "draft") return [];
  const what =
    change.kind === "moved"
      ? `moved only in this chat's draft; live still has it at ${change.from}`
      : "deleted only in this chat's draft; it stays live";
  return [
    `not applied yet: ${what} until the user applies it. Tell the user it is waiting for their review.`,
  ];
}

function blockCount(count: number): string {
  return count === 1 ? "1 block" : `${count} blocks`;
}

/**
 * A finished call's result in brief, for one history line (D48): the status
 * when it isn't plain success, the write handle, `words` (the size of the
 * content the call sent, which only the host has), the draft it changed, what it
 * copied, and a read's block count.
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
  if (result.namespace)
    facts.push(
      result.namespace.kind === "moved" ? `moved from ${result.namespace.from}` : "deleted",
    );
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
 * (w3)` for a write held in a named Work's draft; No Work's draft has no
 * handle to name, so it is plain `draft`. Undo and redo name none.
 */
function writeVersion(result: Pick<AgentEditResultV1, "destination" | "draftWork">): string {
  if (result.destination === "draft" && result.draftWork !== undefined)
    return result.draftWork === "/" ? "draft" : `draft (${result.draftWork})`;
  return result.destination === "live" ? "live" : "";
}

const UNCHANGED_NOTE = "unchanged: the document already matches this content; nothing was written.";

function notes(result: AgentEditResultV1): string[] {
  const lines: string[] = [];
  const removed = result.write?.deletedHashes ?? [];
  if (removed.length > 0) lines.push(`removed: ${removed.join(", ")}`);
  if (result.status === "reconciled") {
    lines.push("later edits were kept, so the text may not match how it was before the write.");
  }
  if (result.documentEmpty) lines.push("document is now empty; its one blank block always stays.");
  const surviving = result.namespace?.kind === "deleted" ? result.namespace.survivingWorks : [];
  if (surviving?.length)
    lines.push(
      `${listed(surviving)} still ${surviving.length === 1 ? "has" : "have"} changes to it; applying them brings it back.`,
    );
  if (result.unchanged) lines.push(UNCHANGED_NOTE);
  if (result.awarenessDegraded) {
    lines.push("destructive awareness degraded after durable recovery; re-read required");
  }
  return lines;
}

function listed(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Concurrent changes grouped by the peer that made them. */
function concurrentLines(listing: AgentEditConcurrentListing): string[] {
  return listing.groups.flatMap((group) => {
    const details = [
      ...(group.shown?.length ? [`  also shown above: ${group.shown.join(" ")}`] : []),
      ...group.blocks.map((item) => `  ${blockLine(item)}`),
      ...(group.removed?.length ? [`  removed: ${group.removed.join(" ")}`] : []),
      ...(group.more
        ? [group.more === 1 ? "  1 more change" : `  ${group.more} more changes`]
        : []),
    ];
    if (details.length === 1 && group.shown?.length) {
      return [`concurrent edits by ${group.author}: ${group.shown.join(" ")}`];
    }
    return [`concurrent edits by ${group.author}:`, ...details];
  });
}

/** The file an outline's sections are read from; undefined when the result isn't an outline. */
function outlineFile(result: AgentEditResultV1): string | undefined {
  if (result.read?.format !== "outline" || !result.path) return undefined;
  return splitDocumentFile(result.path).filePath;
}

function bodyLines(groups: readonly AgentEditBlockGroup[], outline: string | undefined): string[] {
  const items = groups.flatMap((group) => group.items);
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
