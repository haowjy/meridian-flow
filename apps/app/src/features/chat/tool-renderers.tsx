/** Curated renderers for chat tool activity rows. */
import { t } from "@lingui/core/macro";
import {
  type JsonValue,
  meridianErrorFromStructuredToolOutput,
} from "@meridian/contracts/protocol";
import type { ToolView } from "@meridian/thread-client";
import {
  documentToolFailed,
  sourcePath,
  stringInput,
  toolCommand,
  toolInputObject,
} from "@meridian/thread-client";
import { ChevronRight, FileText, Folder } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";
import { BoundLine, ClippedProse } from "./ClippedExpand";
import { CommandTitle } from "./CommandTitle";
import {
  type CommandExpand,
  descriptorFor,
  humanizeToolName,
  type ToolActivityPhrase,
  toolActivityPhrase,
} from "./command-descriptor";
import { DocumentName } from "./DocumentName";
import type { OwnerNames } from "./document-display-name";
import { documentDisplayName, folderDisplayName } from "./document-display-name";
import { namespaceRefusalCopy } from "./namespace-refusal-copy";
import { useOwnerNames } from "./owner-names";
import { PassageDoor } from "./PassageDoor";
import { type OutlineHeading, readPayloadMarkup, readPayloadOutline } from "./read-payload";
import { THREAD_MESSAGE_RENDERER } from "./thread-message-renderer";
import { THREAD_REPORT_RENDERER } from "./thread-report-renderer";
import {
  boundLabel,
  type CappedList,
  capList,
  LISTING_CAP,
  matchCountLabel,
  moreMatchesLabel,
  normalizeListing,
  normalizeSearchHits,
  type SearchHitRow,
  type SearchResultRows,
  searchCardSummary,
  type ToolResultRow,
  type ToolResultRows,
} from "./tool-result-preview";

/** Builds an expand's contents on demand. */
export type ToolExpand = () => ReactNode;

export type ToolRenderer = {
  /** Single-line summary of the tool action. Already i18n'd. */
  title: (tool: ToolView) => ReactNode;
  /** Deferred inline expansion. `null` = no expand affordance on this row. */
  expand?: (tool: ToolView) => ToolExpand | null;
};

/* ── input helpers ─────────────────────────────────────────────────────── */

function inputObject(tool: ToolView): Record<string, JsonValue> {
  return toolInputObject(tool);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Undo and redo can allocate a free name; their settled result owns the document door. */
function settledDocumentPath(tool: ToolView, fallback: string | undefined): string | undefined {
  const command = toolCommand(tool);
  if (tool.status !== "complete" || (command !== "undo" && command !== "redo")) return fallback;
  const result = tool.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return fallback;
  return asString(result.path) ?? fallback;
}

/** A parameter the timeline shows as text rather than as a destination. */
function TextParameter({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate">{children}</span>;
}

function PhraseTitle({ phrase }: { phrase: ToolActivityPhrase }) {
  return (
    <CommandTitle
      verb={phrase.verb}
      parameter={phrase.parameter ? <TextParameter>{phrase.parameter}</TextParameter> : undefined}
    />
  );
}

/* ── inline-expand renderers (curated, never JSON) ─────────────────────── */

function rowKey(row: ToolResultRow, index: number): string {
  return `${index}:${row.uri}`;
}

function ResultRows({ results }: { results: SearchResultRows }) {
  const bound = boundLabel(results);
  return (
    <div className="chat-card bg-result-card">
      <p className="border-border-subtle border-b pb-2 text-meta text-ink-subtle">
        {searchCardSummary(results)}
      </p>
      <ul>
        {results.rows.map((row, index) => (
          <li
            key={`${index}:${row.uri}`}
            className={cn(
              "py-[var(--chat-card-pad-y)]",
              index > 0 && "border-border-subtle border-t",
            )}
          >
            <SearchHit row={row} />
          </li>
        ))}
      </ul>
      {bound ? <BoundLine>{bound}</BoundLine> : null}
    </div>
  );
}

/** One document's section: its name, how much of the query it holds, its best passage, and a way to see the rest without leaving the transcript. */
function SearchHit({ row }: { row: SearchHitRow }) {
  const [open, setOpen] = useState(false);
  const [best, ...rest] = row.passages;
  return (
    <>
      <div className="flex min-w-0 items-baseline gap-[var(--chat-space-inline)] text-compact font-medium text-prose-foreground">
        <DocumentName path={row.uri} />
        <MatchCount count={row.matchCount} />
      </div>
      <div className="mt-0.5">
        <PassageDoor path={row.uri} excerpt={best.excerpt} passage={best.passage} />
      </div>
      {rest.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={(event) => {
              // The row behind this section is the expand toggle; growing a
              // document must not fold the whole search away.
              event.stopPropagation();
              setOpen((wasOpen) => !wasOpen);
            }}
            className="focus-ring mt-[var(--chat-space-inline)] inline-flex items-center gap-[var(--chat-space-inline)] rounded-sm text-meta text-muted-foreground underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-jade-text hover:decoration-jade-text focus-visible:text-jade-text focus-visible:decoration-jade-text"
          >
            {moreMatchesLabel(rest.length)}
            <ChevronRight
              aria-hidden
              className={cn("size-2.5 transition-transform", open && "rotate-90")}
            />
          </button>
          {open ? (
            // Indented against a rule so the extra passages read as belonging
            // to the document above them. It grows in place: the transcript is
            // the single scroll owner and no expand may own another.
            <div className="mt-[var(--chat-space-inline)] ml-[var(--chat-tool-list-indent)] space-y-[var(--chat-space-row)] border-border-subtle border-l pl-2.5">
              {rest.map((passage, index) => (
                <PassageDoor
                  key={`${index}:${passage.excerpt.match}${passage.excerpt.trail}`}
                  path={row.uri}
                  excerpt={passage.excerpt}
                  passage={passage.passage}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function MatchCount({ count }: { count: number }) {
  return (
    <span className="ml-auto inline-grid min-w-5 shrink-0 place-items-center rounded-full border border-border bg-muted px-2 py-0.5 text-meta font-semibold text-ink-muted">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{matchCountLabel(count)}</span>
    </span>
  );
}

const LISTING_ROW =
  "flex min-w-0 items-baseline gap-[var(--chat-space-inline)] py-0.5 text-compact";

function ListingRows({ results }: { results: ToolResultRows }) {
  const bound = boundLabel(results);
  return (
    <>
      <ul>
        {results.rows.map((row, index) => (
          <li key={rowKey(row, index)} className={LISTING_ROW}>
            {row.kind === "folder" ? (
              <>
                <Folder className="size-3 shrink-0 self-center text-ink-subtle" aria-hidden />
                <span className="min-w-0 truncate text-prose-foreground">
                  {folderDisplayName(row.uri)}
                </span>
              </>
            ) : (
              <>
                <FileText className="size-3 shrink-0 self-center text-ink-subtle" aria-hidden />
                <DocumentName path={row.uri} />
              </>
            )}
          </li>
        ))}
      </ul>
      {bound ? <BoundLine>{bound}</BoundLine> : null}
    </>
  );
}

/** The agent-edit status of a failed `read` or `write`, from its typed result. */
function documentFailureStatus(tool: ToolView): string | null {
  const result = tool.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  return asString(result.status) ?? null;
}

function copySource(tool: ToolView): string | null {
  if (toolCommand(tool) !== "copy") return null;
  const source = sourcePath(inputObject(tool));
  return source ? documentDisplayName(source) : null;
}

function copyNotFoundCopy(tool: ToolView, source: string, destination: string | null): string {
  if (stringInput(inputObject(tool), "command") === "copy") return t`Couldn't find ${source}.`;
  return destination ? t`Couldn't find ${source} or ${destination}.` : t`Couldn't find ${source}.`;
}

/** The document a failed call acted on: a move's is its source, not where it was going. */
function documentFailureDocumentName(tool: ToolView): string | null {
  const input = inputObject(tool);
  const path = toolCommand(tool) === "move" ? sourcePath(input) : asString(input.path);
  if (!path) return null;
  return documentDisplayName(path);
}

/** Whether the row reports a failure to the writer. */
export function toolRowFailed(tool: ToolView): boolean {
  return documentToolFailed(tool);
}

/** Writer copy is derived from failure shape; machine messages remain diagnostics only. */
export function documentToolFailureCopy(tool: ToolView, names?: OwnerNames): string {
  const name = documentFailureDocumentName(tool);
  const status = documentFailureStatus(tool);
  switch (status) {
    case "binary_file": {
      // A block copy's binary file is its source, not the destination in `path`.
      const binary = copySource(tool) ?? name;
      return binary ? t`${binary} is a binary file.` : t`That file is binary.`;
    }
    case "not_found":
    case "document_not_found": {
      // `path` names the destination, but a copy's missing document is its
      // source (or, for a block copy, either one), so the copy says which.
      const source = copySource(tool);
      if (source) return copyNotFoundCopy(tool, source, name);
      return name ? t`Couldn't find ${name}.` : t`That document couldn't be found.`;
    }
    case "ambiguous_path":
      return name
        ? t`Two of this Work's drafts share the path ${name}. Review the drafts to keep one.`
        : t`Two of this Work's drafts share this path. Review the drafts to keep one.`;
    case "ambiguous_match":
      return name
        ? t`The requested passage in ${name} wasn't specific enough.`
        : t`The requested passage wasn't specific enough.`;
  }
  // A read changes nothing, so the change-shaped copy below never fits it.
  if (tool.toolName === "read") {
    return name
      ? t`Something went wrong while reading ${name}.`
      : t`Something went wrong while reading that document.`;
  }
  switch (status) {
    case "cant_undo_dependent":
      return t`That change can't be undone because later edits depend on it.`;
    case "cant_undo_applied":
      return t`That change can't be undone here because it was already applied to your manuscript.`;
    case "cant_undo_discarded":
      return t`That change can't be undone because it was discarded.`;
    case "cant_undo_changed":
      return t`That change can't be undone because the text changed afterwards.`;
    case "cant_redo_applied":
      return t`That change can't be redone here because it was already applied to your manuscript.`;
    case "cant_redo_discarded":
      return t`That change can't be redone because it was discarded.`;
    case "cant_redo_changed":
      return t`That change can't be redone because the text changed afterwards.`;
    case "cant_redo_users_undo":
      return t`That change can't be redone because you undid it.`;
    case "insufficient_undo":
      return t`There isn't enough left to undo.`;
    case "insufficient_redo":
      return t`There isn't enough left to redo.`;
    case "nothing_to_revert":
      return t`That change wasn't reverted because its text changed or is already gone.`;
    case "work_archived":
      return t`That change can't be made because this Work's drafts are archived.`;
    case "permission_denied":
      return name ? t`${name} can't be changed.` : t`That document can't be changed.`;
    case "partial_failure":
      return name
        ? t`Some changes to ${name} couldn't be completed.`
        : t`Some changes couldn't be completed.`;
    case "invalid_write": {
      const refused = namespaceRefusalCopy(inputObject(tool), documentFailureRefusal(tool), names);
      if (refused) return refused;
      const reason =
        documentFailureRejected(tool) === "removed"
          ? removedWriteCopy(name, documentFailureRemoval(tool))
          : rejectionCopy(documentFailureRejected(tool));
      if (reason) return reason;
      return name ? t`That change couldn't be made in ${name}.` : t`That change couldn't be made.`;
    }
    default:
      return name
        ? t`Something went wrong while changing ${name}.`
        : t`Something went wrong while making that change.`;
  }
}

/** Why a `move` or `delete` was refused, from its typed result. */
function documentFailureRefusal(tool: ToolView): string | null {
  const result = tool.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  return asString(result.refusal) ?? null;
}

/** The host's structured reason a staged write was rejected, when it gave one. */
function documentFailureRejected(tool: ToolView): string | null {
  const result = tool.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  return asString(result.rejected) ?? null;
}

/**
 * Who removed a refused write's document and how, when the host sent the
 * record with a `removed` rejection. A named person or Work is named; anyone
 * else reads passively.
 */
function documentFailureRemoval(tool: ToolView): {
  by:
    | { kind: "person" | "work"; name: string }
    | { kind: "agent"; chat: string | null }
    | { kind: "unfinished-reply" }
    | null;
  reason: "deleted" | "discarded";
} {
  const result = tool.result;
  const removal =
    result && typeof result === "object" && !Array.isArray(result) ? result.removal : null;
  if (!removal || typeof removal !== "object" || Array.isArray(removal))
    return { by: null, reason: "deleted" };
  const actor = removal.actor;
  const record = actor && typeof actor === "object" && !Array.isArray(actor) ? actor : null;
  const name = (value: unknown) => (typeof value === "string" && value ? value : null);
  const person = record?.kind === "user" ? name(record.displayName) : null;
  const work = record?.kind === "work" ? name(record.name) : null;
  return {
    by: person
      ? { kind: "person", name: person }
      : work
        ? { kind: "work", name: work }
        : record?.kind === "agent"
          ? { kind: "agent", chat: name(record.chatTitle) }
          : record?.kind === "system" && record.cause !== "repair"
            ? { kind: "unfinished-reply" }
            : null,
    reason: removal.reason === "discarded" ? "discarded" : "deleted",
  };
}

/** A write refused because its document was removed before the reply saved it. */
function removedWriteCopy(
  name: string | null,
  removal: ReturnType<typeof documentFailureRemoval>,
): string {
  const { by } = removal;
  if (by?.kind === "unfinished-reply")
    return name
      ? t`${name} was removed when the reply that created it didn't finish, so this change wasn't made.`
      : t`This document was removed when the reply that created it didn't finish, so this change wasn't made.`;
  if (by?.kind === "person") {
    const who = by.name;
    return removal.reason === "discarded"
      ? name
        ? t`${who} discarded ${name} from the draft before this reply saved its change.`
        : t`${who} discarded this document from the draft before this reply saved its change.`
      : name
        ? t`${who} deleted ${name} before this reply saved its change.`
        : t`${who} deleted this document before this reply saved its change.`;
  }
  if (by?.kind === "work") {
    const work = by.name;
    return name
      ? t`${name} was deleted with the Work ${work} before this reply saved its change.`
      : t`This document was deleted with the Work ${work} before this reply saved its change.`;
  }
  if (by?.kind === "agent") {
    const chat = by.chat;
    return chat
      ? name
        ? t`The AI in ${chat} deleted ${name} before this reply saved its change.`
        : t`The AI in ${chat} deleted this document before this reply saved its change.`
      : name
        ? t`The AI in a chat deleted ${name} before this reply saved its change.`
        : t`The AI in a chat deleted this document before this reply saved its change.`;
  }
  return removal.reason === "discarded"
    ? name
      ? t`${name} was discarded from the draft before this reply saved its change.`
      : t`This document was discarded from the draft before this reply saved its change.`
    : name
      ? t`${name} was deleted before this reply saved its change.`
      : t`This document was deleted before this reply saved its change.`;
}

function rejectionCopy(rejected: string | null): string | null {
  switch (rejected) {
    case "discarded_draft":
      return t`This draft was discarded, so the change wasn't kept. The AI will read it again.`;
    case "discarded_document":
      return t`This new document was discarded, so the change wasn't kept. The AI will read it again.`;
    case "discarded_edit":
      return t`The text it edited was discarded, so the change wasn't kept. The AI will read it again.`;
    case "inverse":
      return t`The text it edited was undone, so the change wasn't kept. The AI will read it again.`;
    case "integration":
      return t`The change didn't fit the current draft. The AI will read it again.`;
    default:
      return null;
  }
}

function DocumentToolTitle({ tool }: { tool: ToolView }) {
  const names = useOwnerNames();
  const input = inputObject(tool);
  const path = settledDocumentPath(tool, asString(input.path));
  const descriptor = descriptorFor(tool);
  const command = toolCommand(tool);

  if (documentToolFailed(tool)) {
    const verb = descriptor.failureVerb();
    // A move that didn't run left its document where it was.
    const subject = command === "move" ? (sourcePath(input) ?? path) : path;
    return subject ? (
      <CommandTitle verb={verb} parameter={<DocumentName path={subject} />} />
    ) : (
      verb
    );
  }

  const phrase = toolActivityPhrase(tool, names);
  // A partial call has no settled path yet, so the row names no document —
  // and therefore offers no door onto one.
  if (tool.status !== "complete") return <PhraseTitle phrase={phrase} />;
  if (!path) return descriptor.pathlessTitle?.() ?? <PhraseTitle phrase={phrase} />;
  // A deleted document's old address may hold another document now: no door.
  if (command === "delete") return <PhraseTitle phrase={phrase} />;
  return (
    <CommandTitle
      verb={phrase.verb}
      parameter={
        <DocumentName path={path} name={command === "move" ? phrase.parameter : undefined} />
      }
    />
  );
}

const COMMAND_EXPANDS: Record<CommandExpand, (tool: ToolView) => ToolExpand | null> = {
  none: () => null,
  renderer: () => null,
  "result-preview": resultPreview,
  "result-outline": resultOutline,
  "submitted-content": submittedContent,
};

function documentExpand(tool: ToolView): ToolExpand | null {
  if (documentToolFailed(tool)) {
    return () => <DocumentFailureText tool={tool} />;
  }
  return COMMAND_EXPANDS[descriptorFor(tool).expand](tool);
}

function DocumentFailureText({ tool }: { tool: ToolView }) {
  const names = useOwnerNames();
  return (
    <div className="text-compact text-destructive">{documentToolFailureCopy(tool, names)}</div>
  );
}

function readPath(tool: ToolView): string | undefined {
  return asString(inputObject(tool).path);
}

function resultPreview(tool: ToolView): ToolExpand | null {
  const markup = readPayloadMarkup(tool.result);
  if (!markup) return null;
  const path = readPath(tool);
  return () => <QuotedPreview markup={markup} path={path} />;
}

function resultOutline(tool: ToolView): ToolExpand | null {
  const headings = readPayloadOutline(tool.result);
  // A document with no headings falls back to whole blocks server-side, so the
  // result really is prose and the row should show it as prose.
  if (!headings) return resultPreview(tool);
  const outline = capList(headings, LISTING_CAP);
  return () => <OutlineRows outline={outline} />;
}

/** What the model submitted, read from the tool *input*: the result reports what changed, and only the input holds the exact content. */
function submittedContent(tool: ToolView): ToolExpand | null {
  const content = asString(inputObject(tool).content);
  if (!content) return null;
  const path = readPath(tool);
  return () => (
    <div className="chat-card [--chat-card-border:var(--color-border-subtle)] bg-muted">
      <QuotedPreview markup={content} path={path} />
    </div>
  );
}

function listingOrNothing(tool: ToolView): ToolExpand | null {
  const results = normalizeListing(tool.result ?? undefined);
  if (results.rows.length === 0) return null;
  return () => <ListingRows results={results} />;
}

function resultRowsOrNothing(tool: ToolView): ToolExpand | null {
  // A chevron is a promise, and here the contract keeps it: a search hit that
  // cannot fill a section is refused at normalization, so a non-empty payload
  // IS content. That lets the closed row answer "is there anything here?" by
  // looking at the array, and leaves every section — and the totals scan —
  // for the writer who actually opens it. A settled turn holds a dozen closed
  // rows; none of them should be parsing search results.
  const hits = tool.result;
  if (!Array.isArray(hits) || hits.length === 0) return null;
  return () => (
    <ResultRows results={normalizeSearchHits(hits, stringInput(inputObject(tool), "pattern"))} />
  );
}

function QuotedPreview({ markup, path }: { markup: string; path?: string }) {
  return (
    <ClippedProse
      className="text-tier-quoted"
      footer={path ? <OpenDocumentDoor path={path} /> : null}
    >
      <Markdown>{markup}</Markdown>
    </ClippedProse>
  );
}

function OpenDocumentDoor({ path }: { path: string }) {
  return (
    <span className="flex min-w-0 text-meta">
      <DocumentName path={path} label="open" />
    </span>
  );
}

function OutlineRows({ outline }: { outline: CappedList<OutlineHeading> }) {
  const bound = boundLabel(outline);
  return (
    <>
      <ul>
        {outline.rows.map((heading, index) => (
          <li
            key={`${index}:${heading.text}`}
            className={cn(LISTING_ROW, "text-prose-foreground")}
            style={{ paddingLeft: `${heading.level * 16}px` }}
          >
            <span className="min-w-0 truncate">{heading.text}</span>
          </li>
        ))}
      </ul>
      {bound ? <BoundLine>{bound}</BoundLine> : null}
    </>
  );
}

function WorkToolTitle({ tool }: { tool: ToolView }) {
  if (tool.isError) return descriptorFor(tool).failureVerb();
  // `block` so truncate applies: the title slot is a flexified span, and an
  // inline child cannot clip its own overflow.
  return <span className="block truncate">{toolActivityPhrase(tool).verb}</span>;
}

function workExpand(tool: ToolView): ToolExpand | null {
  if (!tool.isError || tool.result == null) return null;
  const message = meridianErrorFromStructuredToolOutput(tool.result).message;
  if (!message) return null;
  return () => <div className="text-compact text-destructive">{message}</div>;
}

/* ── registry ──────────────────────────────────────────────────────────── */

/** A registered tool whose whole title is its phrase, with no document to name. */
function phraseTitle(tool: ToolView): ReactNode {
  // A failure is its own claim: `Searched "Elara"` over an error row says the
  // search happened.
  if (tool.isError) return descriptorFor(tool).failureVerb();
  return <PhraseTitle phrase={toolActivityPhrase(tool)} />;
}

/** Tier-1 default — unknown tool. */
const DEFAULT_RENDERER: ToolRenderer = {
  title: (tool) => humanizeToolName(tool.toolName),
};

const DOCUMENT_TOOL_RENDERER: ToolRenderer = {
  title: (tool) => <DocumentToolTitle tool={tool} />,
  expand: documentExpand,
};

const RENDERERS: Record<string, ToolRenderer> = {
  read: DOCUMENT_TOOL_RENDERER,
  write: DOCUMENT_TOOL_RENDERER,
  ls: {
    title: phraseTitle,
    expand: listingOrNothing,
  },
  search: {
    title: phraseTitle,
    expand: resultRowsOrNothing,
  },
  // The skill body is for the model; "Couldn't run that skill" is a failure's
  // whole claim. Neither row has anything for the writer to open.
  skill: {
    title: phraseTitle,
  },
  work: {
    title: (tool) => <WorkToolTitle tool={tool} />,
    expand: workExpand,
  },
  thread_message: THREAD_MESSAGE_RENDERER,
  thread_report: THREAD_REPORT_RENDERER,
};

export function rendererFor(toolName: string): ToolRenderer {
  return RENDERERS[toolName] ?? DEFAULT_RENDERER;
}
