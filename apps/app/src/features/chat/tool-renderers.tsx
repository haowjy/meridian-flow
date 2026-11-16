/** Curated renderers for chat tool activity rows. */
import { t } from "@lingui/core/macro";
import { asUserId } from "@meridian/contracts";
import {
  type DocumentRemovalRecord,
  isToolNotRunResult,
  type JsonValue,
} from "@meridian/contracts/protocol";
import type { ToolView } from "@meridian/thread-client";
import {
  documentToolFailed,
  documentToolReturned,
  mcpCallFailed,
  mcpRunFailed,
  sourcePath,
  stringInput,
  toolCommand,
  toolInputObject,
} from "@meridian/thread-client";
import { FileText, Folder } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useCachedChatTitles } from "@/client/query/project-thread-cache";
import { Chip } from "@/components/ui/chip";
import { FoldToggle } from "@/components/ui/fold-toggle";
import {
  type ChatTitles,
  removalVoice,
  removedBeforeChangeSentence,
} from "@/features/project/context/RemovedDocumentNotice";
import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";
import { BoundLine, ClippedProse } from "./ClippedExpand";
import { CommandTitle } from "./CommandTitle";
import {
  type CommandExpand,
  descriptorFor,
  failureOrReturnedVerb,
  humanizeToolName,
  movedTo,
  settledDocumentPath,
  type ToolActivityPhrase,
  toolActivityPhrase,
} from "./command-descriptor";
import { DocumentName } from "./DocumentName";
import { documentDisplayName, folderDisplayName } from "./document-display-name";
import { MCP_CALL_RENDERER, MCP_DESCRIBE_RENDERER, MCP_RUN_RENDERER } from "./mcp-renderers";
import { useOwnerNames } from "./owner-names";
import { PassageDoor } from "./PassageDoor";
import {
  type OutlineHeading,
  type ReadFile,
  readPayloadFile,
  readPayloadMarkup,
  readPayloadOutline,
} from "./read-payload";
import { THREAD_MESSAGE_RENDERER } from "./thread-message-renderer";
import { THREAD_REPORT_RENDERER } from "./thread-report-renderer";
import {
  boundLabel,
  type CappedList,
  capList,
  type GrepHitRow,
  type GrepResultRows,
  grepCardSummary,
  LISTING_CAP,
  matchCountLabel,
  moreMatchesLabel,
  normalizeGrepResult,
  normalizeListing,
  type ToolResultRow,
  type ToolResultRows,
} from "./tool-result-preview";

/** Builds an expand's contents on demand. */
export type ToolExpand = () => ReactNode;

export type ToolRenderer = {
  /** Single-line summary of the tool action. Already i18n'd. */
  title: (tool: ToolView) => ReactNode;
  /**
   * Deferred inline expansion. `null` = no expand affordance on this row. `renderRow` draws a
   * tool as a row of its own, for a tool that holds others (a script's calls).
   */
  expand?: (tool: ToolView, renderRow: (tool: ToolView) => ReactNode) => ToolExpand | null;
};

/* ── input helpers ─────────────────────────────────────────────────────── */

function inputObject(tool: ToolView): Record<string, JsonValue> {
  return toolInputObject(tool);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function ResultRows({ results }: { results: GrepResultRows }) {
  const bound = boundLabel(results);
  return (
    <div className="chat-card bg-ink-fill">
      <p
        className={cn(
          "text-xs text-muted-foreground",
          results.rows.length > 0 && "border-border-subtle border-b pb-2",
        )}
      >
        {grepCardSummary(results)}
      </p>
      {results.rows.length > 0 ? (
        <ul>
          {results.rows.map((row, index) => (
            <li
              key={`${index}:${row.uri}`}
              className={cn(
                "py-[var(--chat-card-pad-y)]",
                index > 0 && "border-border-subtle border-t",
              )}
            >
              <GrepHit row={row} />
            </li>
          ))}
        </ul>
      ) : null}
      {bound ? <BoundLine>{bound}</BoundLine> : null}
    </div>
  );
}

/** One document's section: its name, how much of the query it holds, its best passage, and a way to see the rest without leaving the transcript. */
function GrepHit({ row }: { row: GrepHitRow }) {
  const [open, setOpen] = useState(false);
  const [best, ...rest] = row.passages;
  return (
    <>
      <div className="flex min-w-0 items-baseline gap-[var(--chat-space-inline)] text-compact font-medium text-foreground">
        <DocumentName path={row.uri} />
        {row.matchCount === undefined ? null : <MatchCount count={row.matchCount} />}
      </div>
      {best ? (
        <div className="mt-0.5">
          <PassageDoor path={row.uri} excerpt={best.excerpt} passage={best.passage} />
        </div>
      ) : null}
      {rest.length > 0 ? (
        <>
          <FoldToggle
            open={open}
            onToggle={(event) => {
              // The row behind this section is the expand toggle; growing a
              // document must not fold the whole search away.
              event.stopPropagation();
              setOpen((wasOpen) => !wasOpen);
            }}
            inline
            className="mt-[var(--chat-space-inline)] text-xs"
          >
            {moreMatchesLabel(rest.length)}
          </FoldToggle>
          {open ? (
            // Indented against a rule so the extra passages read as belonging
            // to the document above them. It grows in place: the transcript is
            // the single scroll owner and no expand may own another.
            <div className="mt-[var(--chat-space-inline)] ml-[var(--chat-tool-list-indent)] space-y-[var(--chat-space-inline)] border-border-subtle border-l pl-2.5">
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
    <Chip kind="count" className="ml-auto">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{matchCountLabel(count)}</span>
    </Chip>
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
                <Folder className="size-3 shrink-0 self-center text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate text-foreground">
                  {folderDisplayName(row.uri)}
                </span>
              </>
            ) : (
              <>
                <FileText
                  className="size-3 shrink-0 self-center text-muted-foreground"
                  aria-hidden
                />
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
  if (tool.toolName === "mcp_call") return mcpCallFailed(tool);
  if (tool.toolName === "mcp_run") return mcpRunFailed(tool);
  return documentToolFailed(tool);
}

/** Writer copy is derived from failure shape; machine messages remain diagnostics only. */
export function documentToolFailureCopy(tool: ToolView, chats: ChatTitles): string {
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
    case "cant_undo_applied":
      return t`That change can't be undone here because it was already applied to your manuscript.`;
    case "cant_undo_discarded":
      return t`That change can't be undone because it was discarded.`;
    case "cant_undo_changed":
      return t`That change can't be undone because the text changed afterwards.`;
    case "purged":
      return t`That change can't be undone because what it changed is gone.`;
    case "insufficient_undo":
      return t`There isn't enough left to undo.`;
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
    case "returned":
      return returnedWriteCopy(documentFailureReturned(tool).why, name, tool, chats);
    case "invalid_write":
      return name ? t`That change couldn't be made in ${name}.` : t`That change couldn't be made.`;
    default:
      return name
        ? t`Something went wrong while changing ${name}.`
        : t`Something went wrong while making that change.`;
  }
}

/** The `returned` block of a returned write's typed result: why, and the removal record if any. */
function documentFailureReturned(tool: ToolView): {
  why: string | null;
  removal: ToolView["result"] | null;
} {
  const result = tool.result;
  const returned =
    result && typeof result === "object" && !Array.isArray(result) ? result.returned : null;
  if (!returned || typeof returned !== "object" || Array.isArray(returned))
    return { why: null, removal: null };
  return { why: asString(returned.why) ?? null, removal: returned.removal ?? null };
}

/**
 * The removal record a returned write carried, read from the stored tool result (an older build's
 * may lack fields); null when it has none.
 */
function documentFailureRemoval(tool: ToolView): DocumentRemovalRecord | null {
  const { removal } = documentFailureReturned(tool);
  if (!removal || typeof removal !== "object" || Array.isArray(removal)) return null;
  const actor = removal.actor;
  const record = actor && typeof actor === "object" && !Array.isArray(actor) ? actor : null;
  const text = (value: JsonValue | undefined) =>
    typeof value === "string" && value ? value : null;
  const chatId = text(record?.chatId);
  const userId = text(record?.userId);
  return {
    reason: removal.reason === "discarded" ? "discarded" : "deleted",
    actor:
      record?.kind === "user" && userId
        ? { kind: "user", userId: asUserId(userId), displayName: text(record.displayName) }
        : record?.kind === "agent"
          ? { kind: "agent", chatTitle: text(record.chatTitle), ...(chatId ? { chatId } : {}) }
          : null,
    time: "",
  };
}

/** An edit the document's state returned: nothing was kept, and the AI was shown the document as it stands. */
function returnedWriteCopy(
  why: string | null,
  name: string | null,
  tool: ToolView,
  chats: ChatTitles,
): string {
  switch (why) {
    case "document_removed":
      return removedBeforeChangeSentence(name, removalVoice(documentFailureRemoval(tool), chats));
    case "work_archived":
      return t`This Work is archived, so its drafts take no new text and the change wasn't kept.`;
    case "work_deleted":
      return t`This Work is deleted, so its drafts take no new text and the change wasn't kept.`;
    case "block_gone":
      return t`That paragraph was deleted, merged or moved before the change was made, so it wasn't kept. The AI carries on from the document as it stands.`;
    default:
      return name ? t`That change wasn't kept in ${name}.` : t`That change wasn't kept.`;
  }
}

/**
 * A call the run ended never failed: its row names what it was going to do, whatever the tool. A
 * stored "not run" says it never ran; a call the view found unanswered only says it was stopped.
 */
export function EndedCallTitle({ tool }: { tool: ToolView }) {
  const names = useOwnerNames();
  const { verb, parameter } = descriptorFor(tool).phrases(tool, names).active;
  const label = [verb, parameter].filter(Boolean).join(" ").replace(/…$/, "");
  return isToolNotRunResult(tool.result) ? t`Didn't run: ${label}` : t`Stopped: ${label}`;
}

function DocumentToolTitle({ tool }: { tool: ToolView }) {
  const names = useOwnerNames();
  const input = inputObject(tool);
  const path =
    toolCommand(tool) === "move"
      ? movedTo(tool)
      : (settledDocumentPath(tool) ?? asString(input.path));
  const descriptor = descriptorFor(tool);
  const command = toolCommand(tool);

  if (documentToolFailed(tool)) {
    const verb = failureOrReturnedVerb(tool);
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
  // A deleted document's old address may hold another document now, and a folder opens as no
  // document: no door.
  if (command === "delete" || path.endsWith("/")) return <PhraseTitle phrase={phrase} />;
  return (
    <CommandTitle
      verb={phrase.verb}
      parameter={
        <DocumentName
          path={path}
          name={command === "move" ? phrase.parameter : undefined}
          documentId={readPayloadFile(tool.result)?.documentId}
        />
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
  const file = readPayloadFile(tool.result);
  if (file) {
    const text = COMMAND_EXPANDS[descriptorFor(tool).expand](tool);
    return () => (
      <>
        <p className="text-compact text-muted-foreground">{fileGivenLine(file)}</p>
        {text?.()}
      </>
    );
  }
  return COMMAND_EXPANDS[descriptorFor(tool).expand](tool);
}

/** What the AI was given of a file that isn't a document, in one line. */
function fileGivenLine(file: ReadFile): string {
  switch (file.given) {
    case "media":
      return t`The AI saw this file.`;
    case "text":
      return t`The AI read the text extracted from this file.`;
    case "description":
      return t`The AI can't view this file.`;
  }
}

function DocumentFailureText({ tool }: { tool: ToolView }) {
  const chats = useCachedChatTitles();
  return (
    <div
      className={
        documentToolReturned(tool)
          ? "text-compact text-muted-foreground"
          : "text-compact text-destructive"
      }
    >
      {documentToolFailureCopy(tool, chats)}
    </div>
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
    <div className="chat-card [--chat-card-border:var(--color-border-subtle)] bg-ink-fill">
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
  // A chevron is a promise, and here the contract keeps it: a non-empty
  // `files` IS content. That lets the closed row answer "is there anything
  // here?" by looking at the array, and leaves every section — and the totals
  // scan — for the writer who actually opens it. A settled turn holds a dozen
  // closed rows; none of them should be parsing grep results. A search that stopped
  // before it finished opens too, even with no files: its card says it stopped.
  const result = tool.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const hasFiles = Array.isArray(result.files) && result.files.length > 0;
  if (!hasFiles && result.stopped !== true) return null;
  return () => <ResultRows results={normalizeGrepResult(result)} />;
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
    <span className="flex min-w-0 text-xs">
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
            className={cn(LISTING_ROW, "text-foreground")}
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
  grep: {
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
  },
  save_agents: {
    title: phraseTitle,
  },
  // Only a failed `ask_user` has a row; a question that was asked shows as the takeover and receipt.
  ask_user: {
    title: () => t`Couldn't ask a question`,
  },
  thread_message: THREAD_MESSAGE_RENDERER,
  thread_report: THREAD_REPORT_RENDERER,
  mcp_call: MCP_CALL_RENDERER,
  mcp_describe: MCP_DESCRIBE_RENDERER,
  mcp_run: MCP_RUN_RENDERER,
};

export function rendererFor(toolName: string): ToolRenderer {
  return RENDERERS[toolName] ?? DEFAULT_RENDERER;
}
