/** Curated renderers for chat tool activity rows. */
import { t } from "@lingui/core/macro";
import {
  type JsonValue,
  meridianErrorFromStructuredToolOutput,
} from "@meridian/contracts/protocol";
import { ChevronRight, FileText, Folder } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";
import { isArtifactRef } from "./ArtifactGrid";
import { BoundLine, ClippedProse } from "./ClippedExpand";
import {
  type CommandExpand,
  descriptorFor,
  humanizeToolName,
  type ToolActivityPhrase,
  toolActivityPhrase,
} from "./command-descriptor";
import { DocumentName } from "./DocumentName";
import { documentDisplayName, folderDisplayName } from "./document-display-name";
import type { ToolView } from "./group-delivery-segments";
import { PassageDoor } from "./PassageDoor";
import { payloadText, ReportContent } from "./ReportContent";
import { type OutlineHeading, readPayloadMarkup, readPayloadOutline } from "./read-payload";
import { stringInput, toolInputObject, type WriteMode } from "./tool-command";
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

export type ToolRenderContext = {
  writeMode?: WriteMode;
};

/** Builds an expand's contents on demand. */
export type ToolExpand = () => ReactNode;

export type ToolRenderer = {
  /** Single-line summary of the tool action. Already i18n'd. */
  title: (tool: ToolView, context?: ToolRenderContext) => ReactNode;
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

/** A command and what it acted on, laid out as one line. */
function CommandTitle({ verb, parameter }: { verb: ReactNode; parameter?: ReactNode }) {
  return (
    <span className="flex w-full min-w-0 items-baseline gap-1.5">
      <span className="shrink-0">{verb}</span>
      {parameter ? (
        <span className="flex min-w-0 items-baseline font-normal text-muted-foreground">
          {parameter}
        </span>
      ) : null}
    </span>
  );
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
    <div className="rounded-md border border-border bg-result-card p-2.5">
      <p className="border-border-subtle border-b pb-2 text-meta text-ink-subtle">
        {searchCardSummary(results)}
      </p>
      <ul>
        {results.rows.map((row, index) => (
          <li
            key={`${index}:${row.uri}`}
            className={cn("py-2.5", index > 0 && "border-border-subtle border-t")}
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
      <div className="flex min-w-0 items-baseline gap-[7px] text-compact font-medium text-prose-foreground">
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
            className="focus-ring mt-1 inline-flex items-center gap-0.5 rounded-sm text-meta text-muted-foreground underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-jade-text hover:decoration-jade-text focus-visible:text-jade-text focus-visible:decoration-jade-text"
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
            <div className="mt-1 ml-[13px] space-y-0.5 border-border-subtle border-l pl-2.5">
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
    <span className="ml-auto inline-grid min-w-5 shrink-0 place-items-center rounded-full border border-border bg-muted px-1.5 py-px text-meta font-semibold text-ink-muted">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{matchCountLabel(count)}</span>
    </span>
  );
}

const LISTING_ROW = "flex min-w-0 items-baseline gap-[7px] py-0.5 text-compact";

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

function documentFailureStatus(output: JsonValue | null): string | null {
  if (output == null) return null;
  if (typeof output === "object" && !Array.isArray(output)) {
    const status = asString((output as Record<string, JsonValue>).status);
    if (status) return status;
  }
  const message =
    typeof output === "string" ? output : meridianErrorFromStructuredToolOutput(output).message;
  return /^status:\s*([a-z_]+)/i.exec(message.trim())?.[1]?.toLowerCase() ?? null;
}

function documentFailureDocumentName(tool: ToolView): string | null {
  const path = asString(inputObject(tool).path);
  if (!path) return null;
  return documentDisplayName(path);
}

/** Writer copy is derived from failure shape; machine messages remain diagnostics only. */
export function documentToolFailureCopy(tool: ToolView): string {
  const name = documentFailureDocumentName(tool);
  switch (documentFailureStatus(tool.output)) {
    case "not_found":
    case "document_not_found":
      return name ? t`Couldn't find ${name}.` : t`That document couldn't be found.`;
    case "ambiguous_match":
      return name
        ? t`The requested passage in ${name} wasn't specific enough.`
        : t`The requested passage wasn't specific enough.`;
    case "cant_undo_dependent":
      return t`That change can't be undone because later edits depend on it.`;
    case "partial_failure":
      return name
        ? t`Some changes to ${name} couldn't be completed.`
        : t`Some changes couldn't be completed.`;
    case "invalid_write":
      return name ? t`That change couldn't be made in ${name}.` : t`That change couldn't be made.`;
    default:
      return name
        ? t`Something went wrong while changing ${name}.`
        : t`Something went wrong while making that change.`;
  }
}

function DocumentToolTitle({ tool, context }: { tool: ToolView; context?: ToolRenderContext }) {
  const writeMode = context?.writeMode ?? "direct";
  const path = asString(inputObject(tool).path);
  const descriptor = descriptorFor(tool);

  if (tool.isError) {
    const verb = descriptor.failureVerb(writeMode);
    return path ? <CommandTitle verb={verb} parameter={<DocumentName path={path} />} /> : verb;
  }

  const phrase = toolActivityPhrase(tool, writeMode);
  // A partial call has no settled path yet, so the row names no document —
  // and therefore offers no door onto one.
  if (tool.status !== "complete") return <PhraseTitle phrase={phrase} />;
  if (!path) return descriptor.pathlessTitle?.(writeMode) ?? <PhraseTitle phrase={phrase} />;
  return <CommandTitle verb={phrase.verb} parameter={<DocumentName path={path} />} />;
}

const COMMAND_EXPANDS: Record<CommandExpand, (tool: ToolView) => ToolExpand | null> = {
  none: () => null,
  renderer: () => null,
  "output-preview": outputPreview,
  "output-outline": outputOutline,
  "submitted-content": submittedContent,
};

function documentExpand(tool: ToolView): ToolExpand | null {
  if (tool.isError) {
    return () => (
      <div className="text-compact text-destructive">{documentToolFailureCopy(tool)}</div>
    );
  }
  return COMMAND_EXPANDS[descriptorFor(tool).expand](tool);
}

function readPath(tool: ToolView): string | undefined {
  return asString(inputObject(tool).path);
}

function outputPreview(tool: ToolView): ToolExpand | null {
  const markup = readPayloadMarkup(tool.output);
  if (!markup) return null;
  const path = readPath(tool);
  return () => <QuotedPreview markup={markup} path={path} />;
}

function outputOutline(tool: ToolView): ToolExpand | null {
  const headings = readPayloadOutline(tool.output);
  // A document with no headings falls back to whole blocks server-side, so the
  // payload really is prose and the row should show it as prose.
  if (!headings) return outputPreview(tool);
  const outline = capList(headings, LISTING_CAP);
  return () => <OutlineRows outline={outline} />;
}

/** What the model submitted, read from the tool *input*: the output carries formatted status and diagnostics, and only the input holds the exact content. */
function submittedContent(tool: ToolView): ToolExpand | null {
  const content = asString(inputObject(tool).content);
  if (!content) return null;
  const path = readPath(tool);
  return () => (
    <div className="rounded-md border border-border-subtle bg-muted px-3 py-2">
      <QuotedPreview markup={content} path={path} />
    </div>
  );
}

function listingOrNothing(tool: ToolView): ToolExpand | null {
  const results = normalizeListing(tool.output ?? undefined);
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
  const output = tool.output;
  if (!Array.isArray(output) || output.length === 0) return null;
  return () => (
    <ResultRows results={normalizeSearchHits(output, stringInput(inputObject(tool), "pattern"))} />
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
  if (tool.isError) return descriptorFor(tool).failureVerb("direct");
  // `block` so truncate applies: the title slot is a flexified span, and an
  // inline child cannot clip its own overflow.
  return <span className="block truncate">{toolActivityPhrase(tool).verb}</span>;
}

function workExpand(tool: ToolView): ToolExpand | null {
  if (!tool.isError || tool.output == null) return null;
  const message = meridianErrorFromStructuredToolOutput(tool.output).message;
  if (!message) return null;
  return () => <div className="text-compact text-destructive">{message}</div>;
}

/* ── registry ──────────────────────────────────────────────────────────── */

/** A registered tool whose whole title is its phrase, with no document to name. */
function phraseTitle(tool: ToolView): ReactNode {
  // A failure is its own claim: `Searched "Elara"` over an error row says the
  // search happened.
  if (tool.isError) return descriptorFor(tool).failureVerb("direct");
  return <PhraseTitle phrase={toolActivityPhrase(tool)} />;
}

/** Tier-1 default — unknown tool. */
const DEFAULT_RENDERER: ToolRenderer = {
  title: (tool) => humanizeToolName(tool.toolName),
};

const DOCUMENT_TOOL_RENDERER: ToolRenderer = {
  title: (tool, context) => <DocumentToolTitle tool={tool} context={context} />,
  expand: documentExpand,
};

const THREAD_REPORT_RENDERER: ToolRenderer = {
  title: (tool) => {
    const report = threadReport(tool.output);
    const preview = report ? report.summary || reportPayloadText(report.payload) : "";
    if (preview) return <CommandTitle verb={preview.split(/\r?\n/, 1)[0] ?? ""} />;
    if (tool.message) return <CommandTitle verb={tool.message} />;
    if (report?.status === "not_ready") return <CommandTitle verb={t`Report is still running`} />;
    if (report?.status === "unavailable") return <CommandTitle verb={t`Report is unavailable`} />;
    if (report?.outcome === "failed") return <CommandTitle verb={t`The child run failed`} />;
    if (report?.outcome === "cancelled") return <CommandTitle verb={t`The child run stopped`} />;
    if (report?.artifacts?.length) return <CommandTitle verb={t`Saved artifacts`} />;
    if (report?.reason) return <CommandTitle verb={report.reason} />;
    if (report) return <CommandTitle verb={t`No report text was returned`} />;
    return <CommandTitle verb={t`Report unavailable`} />;
  },
  expand: threadReportExpand,
};

function reportPayloadText(payload: JsonValue | undefined): string {
  return payloadText(payload);
}

const RENDERERS: Record<string, ToolRenderer> = {
  write: DOCUMENT_TOOL_RENDERER,
  ls: {
    title: phraseTitle,
    expand: listingOrNothing,
  },
  search: {
    title: phraseTitle,
    expand: resultRowsOrNothing,
  },
  work: {
    title: (tool) => <WorkToolTitle tool={tool} />,
    expand: workExpand,
  },
  thread_report: THREAD_REPORT_RENDERER,
};

export function rendererFor(toolName: string): ToolRenderer {
  return RENDERERS[toolName] ?? DEFAULT_RENDERER;
}

type ThreadReportView = {
  status?: "not_ready" | "unavailable";
  outcome?: "succeeded" | "failed" | "cancelled";
  summary?: string;
  payload?: JsonValue;
  artifacts?: import("@meridian/contracts/interrupt").ArtifactRef[];
  reason?: string | null;
  partial?: boolean;
};

function threadReport(output: JsonValue | null): ThreadReportView | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const record = output as Record<string, JsonValue>;
  if (record.status === "not_ready" || record.status === "unavailable") {
    return { status: record.status };
  }
  if (
    record.outcome !== "succeeded" &&
    record.outcome !== "failed" &&
    record.outcome !== "cancelled"
  )
    return null;
  return {
    outcome: record.outcome,
    summary: typeof record.summary === "string" ? record.summary : "",
    ...(Object.hasOwn(record, "payload") ? { payload: record.payload } : {}),
    artifacts: Array.isArray(record.artifacts) ? record.artifacts.filter(isArtifactRef) : [],
    reason: typeof record.reason === "string" ? record.reason : null,
    partial: record.partial === true,
  };
}

function threadReportExpand(tool: ToolView): ToolExpand | null {
  const report = threadReport(tool.output);
  if (!report) {
    const message = tool.message;
    return message ? () => <Markdown variant="compact">{message}</Markdown> : null;
  }
  if (report.status)
    return () => (
      <p className="text-caption text-muted-foreground">
        {report.status === "not_ready"
          ? t`This execution has not finished.`
          : t`This report is unavailable.`}
      </p>
    );
  return () => (
    <ReportContent
      report={{
        summary: report.summary ?? "",
        payload: report.payload,
        artifacts: report.artifacts ?? [],
        reason: report.reason,
        partial: report.partial,
      }}
      empty={
        report.outcome === "succeeded"
          ? t`No report text was returned.`
          : t`No partial report text was returned.`
      }
      className="space-y-2"
      emptyClassName="space-y-1 text-caption text-muted-foreground"
    />
  );
}
