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

/** The `read` call that targets one path, in the form results print for the model. */
export function readCall(path: string): string {
  return `read({"path": ${JSON.stringify(path)}})`;
}

/**
 * Renders one status line, any notes (concurrent edits, sweeps, the message),
 * then the blocks as `hash|text` lines.
 */
export function renderAgentEditResult(result: AgentEditResultV1): string {
  const groups = result.blocks ?? [];
  const sections = [[statusLine(result), ...notes(result, groups)].join("\n")];
  if (result.message) sections.push(result.message);
  const body = bodyLines(result, groups);
  if (body.length > 0) sections.push(body.join("\n"));
  return sections.join("\n\n");
}

function statusLine(result: AgentEditResultV1): string {
  const facts = [`status: ${result.status}`];
  if (result.path) facts.push(`path: ${result.path}`);
  if (result.write?.id) facts.push(`write: ${result.write.id}`);
  if (result.reversal && result.reversal.writes.length > 0) {
    facts.push(`${result.reversal.direction}: ${result.reversal.writes.join(", ")}`);
  }
  if (result.read) {
    const count = documentItems(result.blocks ?? []).length;
    facts.push(`blocks: ${count}`);
    if (result.read.format === "outline") facts.push("format: outline");
  }
  return facts.join("; ");
}

function notes(result: AgentEditResultV1, groups: readonly AgentEditBlockGroup[]): string[] {
  const lines: string[] = [];
  const removed = result.write?.deletedHashes ?? [];
  if (removed.length > 0) lines.push(`removed: ${removed.join(", ")}`);
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

function bodyLines(result: AgentEditResultV1, groups: readonly AgentEditBlockGroup[]): string[] {
  const items = groups
    .filter((group) => group.relation !== "swept")
    .flatMap((group) => group.items);
  if (result.read?.format !== "outline" || !result.path) return items.map(blockLine);
  // An outline lists headings; each one prints the call that reads its section.
  const { filePath } = splitDocumentFile(result.path);
  return items.flatMap((item) => [blockLine(item), readCall(`${filePath}#${item.hash}`)]);
}

function documentItems(groups: readonly AgentEditBlockGroup[]): AgentEditBlockItem[] {
  return groups.filter((group) => group.relation === "document").flatMap((group) => group.items);
}

function blockLine(item: AgentEditBlockItem): string {
  return toHashline(item.hash, item.body);
}
