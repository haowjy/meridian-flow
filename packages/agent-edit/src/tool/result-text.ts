// The one renderer from a `read` or `write` result to the text the model sees.
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
  if (result.concurrent) sections.push(concurrentLines(result.concurrent, result).join("\n"));
  const notMoved = result.tree?.notMoved;
  if (notMoved?.length) sections.push(`not moved: ${notMoved.join("; ")}`);
  for (const group of result.tree?.concurrent ?? [])
    sections.push(
      [
        `concurrent tree changes by ${group.author}:`,
        ...group.lines.map((line) => `  ${line}`),
      ].join("\n"),
    );
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
  if (result.tree) facts.push(...treeFacts(result.tree));
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
 * The first drafted tree change of a reply says once that drafted changes wait for review, before
 * the status a model otherwise reads as done; after it, `version: draft (w2)` carries it.
 */
function pendingLine(result: AgentEditResultV1): string[] {
  if (!result.tree?.firstDrafted || result.destination !== "draft") return [];
  return [
    "not applied yet: tree changes in this chat's draft stay out of live until the user applies them. Tell the user they are waiting for review.",
  ];
}

/** The facts of a tree result after the status line's own fields, in the order the spec shows them. */
function treeFacts(tree: NonNullable<AgentEditResultV1["tree"]>): string[] {
  const facts: string[] = [];
  if (tree.moved)
    facts.push(
      tree.moved.made === tree.moved.of
        ? `moved: ${tree.moved.made}`
        : `moved: ${tree.moved.made} of ${tree.moved.of}`,
    );
  if (tree.deleted !== undefined) facts.push(`deleted: ${tree.deleted} inside`);
  if (tree.kept) facts.push(`kept: ${tree.kept}`);
  if (tree.placedAtEnd) facts.push(`placed at end: ${tree.placedAtEnd}`);
  if (tree.alreadyDeleted) facts.push("already deleted by the user");
  return facts;
}

function blockCount(count: number): string {
  return count === 1 ? "1 block" : `${count} blocks`;
}

/**
 * A finished call's result in brief, for one history line: the status
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
 * The version a write changed, in `read`'s terms: `live`, or `draft
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
  const surviving = result.tree?.survivingWorks;
  if (surviving?.length)
    lines.push(
      `${listed(surviving)} still ${surviving.length === 1 ? "has" : "have"} changes to it; applying them brings it back.`,
    );
  if (result.tree?.deletedInLive)
    lines.push("deleted in live by the user: this waits until it is restored");
  if (result.unchanged) lines.push(UNCHANGED_NOTE);
  if (result.awarenessDegraded) {
    lines.push("the write landed, but concurrent changes could not be reported.");
  }
  return lines;
}

function listed(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Who changed which blocks after the model last read them, by hash. Past the limit, one line sends
 * the model back to the file. The one line of repair guidance appears only when a changed block is
 * in the echo, where a merge can have garbled it.
 */
function concurrentLines(listing: AgentEditConcurrentListing, result: AgentEditResultV1): string[] {
  if (listing.reread) {
    const read = result.path
      ? readCall(result.path, result.destination === "live" ? "live" : undefined)
      : "read";
    return [
      `${listing.reread} blocks were changed by others after you last read it, so this result has no echo and no list. The write landed. Your view of this file is out of date: ${read} before you edit it again.`,
    ];
  }
  const lines = listing.groups.flatMap((group) => {
    const changed = [
      ...(group.shown?.map((hash) => `${hash} (in the echo)`) ?? []),
      ...(group.other ?? []),
    ];
    const did = [
      ...(changed.length ? [`changed ${changed.join(", ")}`] : []),
      ...(group.removed?.length ? [`removed ${group.removed.join(", ")}`] : []),
    ];
    return [
      ...(did.length ? [`${group.author} ${did.join(" and ")} after you last read it.`] : []),
      ...(group.overwritten?.length
        ? [`${group.author} changed ${group.overwritten.join(", ")}, which your write removed.`]
        : []),
    ];
  });
  const merged = listing.groups.some((group) => group.shown?.length);
  return [
    ...lines,
    ...(merged
      ? [
          "The echo is the text after both edits merged. If the merge left text broken, fix it; leave what reads right.",
        ]
      : []),
  ];
}

/** The file an outline's sections are read from; undefined when the result isn't an outline. */
function outlineFile(result: AgentEditResultV1): string | undefined {
  if (result.read?.format !== "outline" || !result.path) return undefined;
  return splitDocumentFile(result.path).filePath;
}

function bodyLines(groups: readonly AgentEditBlockGroup[], outline: string | undefined): string[] {
  const items = groups.flatMap((group) => group.items);
  if (!outline)
    return items.flatMap((item) => [
      ...(item.gapLine === undefined ? [] : [item.gapLine]),
      blockLine(item),
    ]);
  // A heading whose slug looks like a hash is read by its hash.
  return items.map((item) => `${blockLine(item)}  #${item.section ?? item.hash}`);
}

function documentItems(groups: readonly AgentEditBlockGroup[]): AgentEditBlockItem[] {
  return groups.filter((group) => group.relation === "document").flatMap((group) => group.items);
}

function blockLine(item: AgentEditBlockItem): string {
  return toHashline(item.hash, item.body);
}
