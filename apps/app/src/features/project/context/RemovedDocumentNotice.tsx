/**
 * What the Editor says when documents it showed were deleted or discarded by
 * something other than this tab. The sentence owns the copy rules; the notice
 * sits in blank space the closed tab left: the tab strip's free end, the
 * landing's top margin, or the phone's notice row.
 */
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { Info, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import {
  useContextRemovalCoordinator,
  useOptionalAccountId,
  useOptionalProjectContextAvailabilityCoordinator,
} from "./account-feature-context";
import type { RemovedDocument, RemovedDocumentNotice } from "./context-removal-coordinator";
import { useContextRemovalProject } from "./use-context-removal-project";

/**
 * How one removal reads. Projects have one owner, so a person who removed it
 * is usually the writer, from another tab or device: they read "You". A Work's
 * removal keeps its authority-loss handling and names no one here.
 */
type RemovalVoice =
  | { kind: "you"; reason: DocumentRemovalRecord["reason"] }
  | { kind: "named"; reason: DocumentRemovalRecord["reason"]; name: string }
  | { kind: "unfinished-reply" }
  | { kind: "anonymous"; reason: DocumentRemovalRecord["reason"] };

function voiceOf(record: DocumentRemovalRecord | null, accountId: string | null): RemovalVoice {
  const reason = record?.reason ?? "deleted";
  const actor = record?.actor;
  if (actor?.kind === "user") {
    if (actor.userId === accountId) return { kind: "you", reason };
    if (actor.displayName) return { kind: "named", reason, name: actor.displayName };
  }
  if (actor?.kind === "system" && actor.cause !== "repair") return { kind: "unfinished-reply" };
  return { kind: "anonymous", reason };
}

function sameVoice(left: RemovalVoice, right: RemovalVoice): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Inside the document's own pane, where the title is already on screen. */
function ThisDocumentRemoval({ voice }: { voice: RemovalVoice }) {
  switch (voice.kind) {
    case "you":
      return voice.reason === "discarded" ? (
        <Trans>You discarded this document from the draft elsewhere.</Trans>
      ) : (
        <Trans>You deleted this document elsewhere.</Trans>
      );
    case "named": {
      const name = voice.name;
      return voice.reason === "discarded" ? (
        <Trans>This document was discarded from the draft by {name}.</Trans>
      ) : (
        <Trans>This document was deleted by {name}.</Trans>
      );
    }
    case "unfinished-reply":
      return <Trans>This document was removed when the reply that created it didn't finish.</Trans>;
    case "anonymous":
      return voice.reason === "discarded" ? (
        <Trans>This document was discarded from the draft.</Trans>
      ) : (
        <Trans>This document was deleted.</Trans>
      );
  }
}

function OneRemoval({ title, voice }: { title: string | null; voice: RemovalVoice }) {
  if (title === null) return <ThisDocumentRemoval voice={voice} />;
  switch (voice.kind) {
    case "you":
      return voice.reason === "discarded" ? (
        <Trans>
          You discarded <strong>{title}</strong> from the draft elsewhere.
        </Trans>
      ) : (
        <Trans>
          You deleted <strong>{title}</strong> elsewhere.
        </Trans>
      );
    case "named": {
      const name = voice.name;
      return voice.reason === "discarded" ? (
        <Trans>
          <strong>{title}</strong> was discarded from the draft by {name}.
        </Trans>
      ) : (
        <Trans>
          <strong>{title}</strong> was deleted by {name}.
        </Trans>
      );
    }
    case "unfinished-reply":
      return (
        <Trans>
          <strong>{title}</strong> was removed when the reply that created it didn't finish.
        </Trans>
      );
    case "anonymous":
      return voice.reason === "discarded" ? (
        <Trans>
          <strong>{title}</strong> was discarded from the draft.
        </Trans>
      ) : (
        <Trans>
          <strong>{title}</strong> was deleted.
        </Trans>
      );
  }
}

/** Several documents closed together read as one count; mixed causes read as "removed". */
function ManyRemovals({ count, voice }: { count: number; voice: RemovalVoice | null }) {
  if (voice?.kind === "you")
    return voice.reason === "discarded" ? (
      <Trans>You discarded {count} documents from the draft elsewhere.</Trans>
    ) : (
      <Trans>You deleted {count} documents elsewhere.</Trans>
    );
  if (voice?.kind === "named" && voice.reason === "deleted") {
    const name = voice.name;
    return (
      <Trans>
        {count} documents were deleted by {name}.
      </Trans>
    );
  }
  if ((voice?.kind === "named" || voice?.kind === "anonymous") && voice.reason === "discarded")
    return <Trans>{count} documents were discarded from the draft.</Trans>;
  if (voice?.kind === "anonymous") return <Trans>{count} documents were deleted.</Trans>;
  return <Trans>{count} documents were removed.</Trans>;
}

/** The one sentence for removed documents, wherever the Editor says it; a null title reads "this document". */
export function RemovedDocumentSentence({
  documents,
}: {
  documents: readonly { title: string | null; record: DocumentRemovalRecord | null }[];
}) {
  const accountId = useOptionalAccountId();
  const voices = documents.map((document) => voiceOf(document.record, accountId));
  const [first] = voices;
  if (!first) return null;
  if (documents.length === 1)
    return <OneRemoval title={documents[0]?.title ?? null} voice={first} />;
  return (
    <ManyRemovals
      count={documents.length}
      voice={voices.every((voice) => sameVoice(voice, first)) ? first : null}
    />
  );
}

/**
 * Why a draft can't be applied: its document was removed. Apply never revives
 * a removed document, so there is nothing to try again.
 */
export function RemovedDocumentApplyRefusal({ record }: { record: DocumentRemovalRecord | null }) {
  const voice = voiceOf(record, useOptionalAccountId());
  switch (voice.kind) {
    case "you":
      return voice.reason === "discarded" ? (
        <Trans>You discarded this document elsewhere, so this draft can't be applied.</Trans>
      ) : (
        <Trans>You deleted this document elsewhere, so this draft can't be applied.</Trans>
      );
    case "named": {
      const name = voice.name;
      return <Trans>This document was deleted by {name}, so this draft can't be applied.</Trans>;
    }
    case "unfinished-reply":
      return (
        <Trans>
          This document was removed when the reply that created it didn't finish, so this draft
          can't be applied.
        </Trans>
      );
    case "anonymous":
      return <Trans>This document was deleted, so this draft can't be applied.</Trans>;
  }
}

function useNoticeNames(documents: readonly RemovedDocument[]): string {
  const { i18n } = useLingui();
  return new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(
    documents.map((document) => document.title),
  );
}

const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, "");

/**
 * The notice lasts until the writer's next navigation in the Editor. It
 * anchors where the pane is once the route has left the removed documents
 * (the removal's own navigation is not the writer's), and a later change of
 * place clears it. A removal that joins the notice re-anchors it.
 */
export function useRemovedNoticeLifetime(
  projectId: string,
  place: Readonly<{ key: string; scheme: string | null; path: string | null }>,
): void {
  const removal = useContextRemovalCoordinator();
  const notice = useContextRemovalProject(projectId).notice;
  const anchor = useRef<{ notice: RemovedDocumentNotice; key: string } | null>(null);
  const { key, scheme, path } = place;
  useEffect(() => {
    if (anchor.current?.notice !== notice) anchor.current = null;
    if (!notice) return;
    const onRemovedDocument = notice.documents.some(
      (document) =>
        document.route.scheme === scheme &&
        trimSlashes(document.route.path) === trimSlashes(path ?? ""),
    );
    if (onRemovedDocument) return;
    if (!anchor.current) anchor.current = { notice, key };
    else if (anchor.current.key !== key) {
      anchor.current = null;
      removal.dismissRemovedNotice(projectId);
    }
  }, [key, notice, path, projectId, removal, scheme]);
}

/** The notice's dismiss control, shared by every placement. */
function DismissNotice({ projectId, className }: { projectId: string; className?: string }) {
  const removal = useContextRemovalCoordinator();
  return (
    <IconButton
      className={className}
      aria-label={t`Dismiss`}
      onClick={() => removal.dismissRemovedNotice(projectId)}
    >
      <X aria-hidden className="size-3" />
    </IconButton>
  );
}

/**
 * The tab strip's placement: a ghost chip in the strip's free end, where the
 * closed tab's width went. It takes only the width the tabs leave and
 * truncates down to its glyph and dismiss; the full sentence and every name
 * stay in its tooltip and accessible name.
 */
export function RemovedDocumentTabNotice({ projectId }: { projectId: string }) {
  const notice = useContextRemovalProject(projectId).notice;
  if (!notice) return null;
  return <TabNotice projectId={projectId} documents={notice.documents} />;
}

function TabNotice({
  projectId,
  documents,
}: {
  projectId: string;
  documents: readonly RemovedDocument[];
}) {
  const names = useNoticeNames(documents);
  const chip = useRef<HTMLDivElement>(null);
  const sentence = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!chip.current) return;
    const text = sentence.current?.textContent ?? "";
    chip.current.title = documents.length > 1 ? `${text} ${names}` : text;
  });
  return (
    <div
      ref={chip}
      role="status"
      data-removed-document-notice
      className="my-1.5 ml-1 flex min-w-0 max-w-[28rem] items-center gap-1.5 rounded-md border border-border border-dashed pr-0.5 pl-2 text-muted-foreground text-xs"
    >
      <Info aria-hidden className="size-3.5 shrink-0" />
      <span
        ref={sentence}
        className="min-w-0 flex-1 truncate @max-[8rem]:sr-only [&_strong]:font-medium [&_strong]:text-foreground"
      >
        <RemovedDocumentSentence documents={documents} />
      </span>
      {documents.length > 1 ? <span className="sr-only">{names}</span> : null}
      <DismissNotice projectId={projectId} className="size-5 shrink-0" />
    </div>
  );
}

/**
 * The landing's placement, when no tab remains: inside the landing's top
 * margin, so the list below never moves when it arrives.
 */
export function RemovedDocumentLandingNotice({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  const notice = useContextRemovalProject(projectId).notice;
  if (!notice) return null;
  return <LandingNotice projectId={projectId} documents={notice.documents} className={className} />;
}

function LandingNotice({
  projectId,
  documents,
  className,
}: {
  projectId: string;
  documents: readonly RemovedDocument[];
  className?: string;
}) {
  const names = useNoticeNames(documents);
  return (
    <div
      role="status"
      data-removed-document-notice
      className={cn("flex items-center gap-2 text-muted-foreground text-sm", className)}
    >
      <p
        className="min-w-0 truncate [&_strong]:font-medium [&_strong]:text-foreground"
        title={names}
      >
        <RemovedDocumentSentence documents={documents} />
        {documents.length > 1 ? <span className="text-ink-subtle"> {names}</span> : null}
      </p>
      <DismissNotice projectId={projectId} className="size-6 shrink-0" />
    </div>
  );
}

/** The phone's placement: its top bar's notice row, the slot a screen's own failures use. */
export function useRemovedDocumentPhoneNotice(projectId: string) {
  const notice = useContextRemovalProject(projectId).notice;
  return notice ? <PhoneNotice projectId={projectId} documents={notice.documents} /> : null;
}

function PhoneNotice({
  projectId,
  documents,
}: {
  projectId: string;
  documents: readonly RemovedDocument[];
}) {
  const names = useNoticeNames(documents);
  return (
    <div role="status" data-removed-document-notice className="flex items-start gap-2 py-1.5">
      <p className="min-w-0 flex-1 py-1 text-foreground text-sm">
        <RemovedDocumentSentence documents={documents} />
        {documents.length > 1 ? <span className="text-muted-foreground"> {names}</span> : null}
      </p>
      <DismissNotice projectId={projectId} className="shrink-0 [@media(pointer:coarse)]:size-11" />
    </div>
  );
}

/**
 * Why an unavailable destination is gone, when it names its document: a
 * removed one says who removed it instead of "unavailable". `checking` while
 * the exact lookup runs, so the destination never shows one verdict, then another.
 */
export function useRemovedDestination(
  projectId: string,
  documentId: string | null,
  title: string,
):
  | { status: "none" | "checking" }
  | { status: "removed"; removal: Pick<RemovedDocument, "title" | "record"> } {
  const availability = useOptionalProjectContextAvailabilityCoordinator();
  const [answer, setAnswer] = useState<{
    key: string;
    record: DocumentRemovalRecord | null | undefined;
  } | null>(null);
  const key = JSON.stringify([projectId, documentId]);
  useEffect(() => {
    if (!documentId || !availability) return;
    let current = true;
    void availability.resolveForOpen(projectId, documentId).then(
      (resolution) => {
        if (current)
          setAnswer({
            key,
            record: resolution.kind === "deleted" ? (resolution.removal ?? null) : undefined,
          });
      },
      () => {
        if (current) setAnswer({ key, record: undefined });
      },
    );
    return () => {
      current = false;
    };
  }, [availability, documentId, key, projectId]);
  if (!documentId || !availability) return { status: "none" };
  if (answer?.key !== key) return { status: "checking" };
  return answer.record === undefined
    ? { status: "none" }
    : { status: "removed", removal: { title, record: answer.record } };
}
