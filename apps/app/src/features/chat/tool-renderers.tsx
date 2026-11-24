import { t } from "@lingui/core/macro";
import { isToolNotRunResult, type JsonValue } from "@meridian/contracts/protocol";
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
import { Chip } from "@/components/ui/chip";
import { FoldToggle } from "@/components/ui/fold-toggle";
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

export type ToolExpand = () => ReactNode;

export type ToolRenderer = {
  /** Single-line summary of the tool action. Already i18n'd. */
  title: (tool: ToolView) => ReactNode;
  expand?: (tool: ToolView, renderRow: (tool: ToolView) => ReactNode) => ToolExpand | null;
};

function inputObject(tool: ToolView): Record<string, JsonValue> {
  return toolInputObject(tool);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

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
              event.stopPropagation();
              setOpen((wasOpen) => !wasOpen);
            }}
            inline
            className="mt-[var(--chat-space-inline)] text-xs"
          >
            {moreMatchesLabel(rest.length)}
          </FoldToggle>
          {open ? (
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

function documentFailureDocumentName(tool: ToolView): string | null {
  const input = inputObject(tool);
  const path = toolCommand(tool) === "move" ? sourcePath(input) : asString(input.path);
  if (!path) return null;
  return documentDisplayName(path);
}

export function toolRowFailed(tool: ToolView): boolean {
  if (tool.toolName === "mcp_call") return mcpCallFailed(tool);
  if (tool.toolName === "mcp_run") return mcpRunFailed(tool);
  return documentToolFailed(tool);
}

export function documentToolFailureCopy(tool: ToolView): string {
  const name = documentFailureDocumentName(tool);
  const status = documentFailureStatus(tool);
  switch (status) {
    case "binary_file": {
      const binary = copySource(tool) ?? name;
      return binary ? t`${binary} is a binary file.` : t`That file is binary.`;
    }
    case "not_found":
    case "document_not_found": {
      const source = copySource(tool);
      if (source) return copyNotFoundCopy(tool, source, name);
      return name ? t`Couldn't find ${name}.` : t`That document couldn't be found.`;
    }
    case "ambiguous_match":
      return name ? t`Couldn't match a passage in ${name}` : t`Couldn't match a passage`;
  }
  if (tool.toolName === "read") {
    return name
      ? t`Something went wrong while reading ${name}.`
      : t`Something went wrong while reading that document.`;
  }
  switch (status) {
    case "cant_undo_applied":
    case "cant_undo_discarded":
    case "cant_undo_changed":
    case "purged":
    case "insufficient_undo":
      return t`Couldn't undo`;
    case "nothing_to_revert":
      return t`Couldn't revert`;
    case "work_archived":
      return t`Work archived`;
    case "permission_denied":
      return name ? t`${name} can't be changed.` : t`That document can't be changed.`;
    case "partial_failure":
      return name
        ? t`Some changes to ${name} couldn't be completed.`
        : t`Some changes couldn't be completed.`;
    case "returned":
      return returnedWriteCopy(documentFailureWhy(tool), name);
    case "invalid_write":
      return name ? t`That change couldn't be made in ${name}.` : t`That change couldn't be made.`;
    default:
      return name
        ? t`Something went wrong while changing ${name}.`
        : t`Something went wrong while making that change.`;
  }
}

function documentFailureWhy(tool: ToolView): string | null {
  const result = tool.result;
  const returned =
    result && typeof result === "object" && !Array.isArray(result) ? result.returned : null;
  if (!returned || typeof returned !== "object" || Array.isArray(returned)) return null;
  return asString(returned.why) ?? null;
}

function returnedWriteCopy(why: string | null, name: string | null): string {
  switch (why) {
    case "work_archived":
      return t`Work archived`;
    case "work_deleted":
      return t`Work deleted`;
    case "block_gone":
      return t`Paragraph gone`;
    default:
      return name ? t`That change wasn't kept in ${name}.` : t`That change wasn't kept.`;
  }
}

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
    const subject = command === "move" ? (sourcePath(input) ?? path) : path;
    return subject ? (
      <CommandTitle verb={verb} parameter={<DocumentName path={subject} />} />
    ) : (
      verb
    );
  }

  const phrase = toolActivityPhrase(tool, names);
  if (tool.status !== "complete") return <PhraseTitle phrase={phrase} />;
  if (!path) return descriptor.pathlessTitle?.() ?? <PhraseTitle phrase={phrase} />;
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
  return (
    <div
      className={
        documentToolReturned(tool)
          ? "text-compact text-muted-foreground"
          : "text-compact text-destructive"
      }
    >
      {documentToolFailureCopy(tool)}
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
  if (!headings) return resultPreview(tool);
  const outline = capList(headings, LISTING_CAP);
  return () => <OutlineRows outline={outline} />;
}

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
  return <span className="block truncate">{toolActivityPhrase(tool).verb}</span>;
}

function phraseTitle(tool: ToolView): ReactNode {
  if (tool.isError) return descriptorFor(tool).failureVerb();
  return <PhraseTitle phrase={toolActivityPhrase(tool)} />;
}

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
  skill: {
    title: phraseTitle,
  },
  work: {
    title: (tool) => <WorkToolTitle tool={tool} />,
  },
  save_agents: {
    title: phraseTitle,
  },
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
