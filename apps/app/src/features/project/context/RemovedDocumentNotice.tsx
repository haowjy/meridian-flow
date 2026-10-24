/**
 * What the app says when documents it showed were deleted or discarded by
 * something other than this tab. The sentence owns the copy rules; the notice
 * sits in blank space the closed document left: the tab strip's free end, the
 * landing's top margin, the dock's header beside "Recent", or the phone's
 * notice row.
 */
import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { Info, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { useOptionalRemovedNotices } from "./account-feature-context";
import type { NoticeSurface, RemovedNoticeSnapshot, ShownRemoval } from "./removed-notice-store";

/** One removed document as a sentence names it; a null title reads "this document". */
export type Removal = Readonly<{ title: string | null; record: DocumentRemovalRecord | null }>;

/**
 * How one removal reads: it names who removed the document, from the record,
 * the same for the current account and anyone else, and never says "you". A
 * user with no display name, a purged actor, or no record read passively.
 */
export type RemovalVoice =
  | { kind: "person"; name: string; reason: DocumentRemovalRecord["reason"] }
  | { kind: "work"; name: string }
  /** The model of a chat deleted it; null `chat` when that chat has no title. */
  | { kind: "agent"; chat: string | null }
  | { kind: "unfinished-reply" }
  | { kind: "anonymous"; reason: DocumentRemovalRecord["reason"] };

export function removalVoice(record: DocumentRemovalRecord | null): RemovalVoice {
  const reason = record?.reason ?? "deleted";
  const actor = record?.actor;
  if (actor?.kind === "user" && actor.displayName)
    return { kind: "person", name: actor.displayName, reason };
  if (actor?.kind === "work") return { kind: "work", name: actor.name };
  if (actor?.kind === "agent") return { kind: "agent", chat: actor.chatTitle };
  if (actor?.kind === "system" && actor.cause !== "repair") return { kind: "unfinished-reply" };
  return { kind: "anonymous", reason };
}

function sameVoice(left: RemovalVoice, right: RemovalVoice): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Inside the document's own pane, where the title is already on screen. */
function thisDocumentSentence(voice: RemovalVoice): string {
  switch (voice.kind) {
    case "person": {
      const { name } = voice;
      return voice.reason === "discarded"
        ? t`${name} discarded this document from the draft.`
        : t`${name} deleted this document.`;
    }
    case "work": {
      const { name } = voice;
      return t`This document was deleted with the Work ${name}.`;
    }
    case "agent": {
      const { chat } = voice;
      return chat
        ? t`The AI in ${chat} deleted this document.`
        : t`The AI in a chat deleted this document.`;
    }
    case "unfinished-reply":
      return t`This document was removed when the reply that created it didn't finish.`;
    case "anonymous":
      return voice.reason === "discarded"
        ? t`This document was discarded from the draft.`
        : t`This document was deleted.`;
  }
}

function oneSentence(title: string, voice: RemovalVoice): string {
  switch (voice.kind) {
    case "person": {
      const { name } = voice;
      return voice.reason === "discarded"
        ? t`${name} discarded ${title} from the draft.`
        : t`${name} deleted ${title}.`;
    }
    case "work": {
      const { name } = voice;
      return t`${title} was deleted with the Work ${name}.`;
    }
    case "agent": {
      const { chat } = voice;
      return chat ? t`The AI in ${chat} deleted ${title}.` : t`The AI in a chat deleted ${title}.`;
    }
    case "unfinished-reply":
      return t`${title} was removed when the reply that created it didn't finish.`;
    case "anonymous":
      return voice.reason === "discarded"
        ? t`${title} was discarded from the draft.`
        : t`${title} was deleted.`;
  }
}

/**
 * Several documents closed together read as one count with their names in
 * parentheses; mixed causes read as "removed".
 */
function manySentence(count: number, names: string, voice: RemovalVoice | null): string {
  if (voice?.kind === "person") {
    const { name } = voice;
    return voice.reason === "discarded"
      ? t`${name} discarded ${count} documents from the draft (${names}).`
      : t`${name} deleted ${count} documents (${names}).`;
  }
  if (voice?.kind === "work") {
    const { name } = voice;
    return t`${count} documents were deleted with the Work ${name} (${names}).`;
  }
  if (voice?.kind === "agent") {
    const { chat } = voice;
    return chat
      ? t`The AI in ${chat} deleted ${count} documents (${names}).`
      : t`The AI in a chat deleted ${count} documents (${names}).`;
  }
  if (voice?.kind === "anonymous")
    return voice.reason === "discarded"
      ? t`${count} documents were discarded from the draft (${names}).`
      : t`${count} documents were deleted (${names}).`;
  return t`${count} documents were removed (${names}).`;
}

/** The one sentence for removed documents, wherever it is said; a null title reads "this document". */
export function removalSentence(documents: readonly Removal[]): string {
  const voices = documents.map((document) => removalVoice(document.record));
  const [first] = voices;
  if (!first) return "";
  if (documents.length === 1) {
    const title = documents[0]?.title ?? null;
    return title === null ? thisDocumentSentence(first) : oneSentence(title, first);
  }
  const names = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    documents.map((document) => document.title ?? t`Untitled`),
  );
  return manySentence(
    documents.length,
    names,
    voices.every((voice) => sameVoice(voice, first)) ? first : null,
  );
}

/**
 * A draft that outlived its document's delete (D79), in the draft's own editor: who deleted it,
 * in the removal notice's voice, and what Apply does about it.
 */
export function deletedFromManuscriptSentence(
  title: string,
  record: DocumentRemovalRecord | null,
): string {
  const voice = removalVoice(record);
  if (voice.kind === "person") {
    const { name } = voice;
    return t`${name} deleted ${title} from the manuscript. Applying brings it back.`;
  }
  if (voice.kind === "agent") {
    const { chat } = voice;
    return chat
      ? t`The AI in ${chat} deleted ${title} from the manuscript. Applying brings it back.`
      : t`The AI in a chat deleted ${title} from the manuscript. Applying brings it back.`;
  }
  return t`${title} was deleted from the manuscript. Applying brings it back.`;
}

/** What a chip says when only a short sentence fits: the count and what happened. */
function shortRemovalSentence(documents: readonly Removal[]): string {
  const count = documents.length;
  const reasons = new Set(
    documents.map((document) => {
      const voice = removalVoice(document.record);
      return voice.kind === "unfinished-reply"
        ? "removed"
        : voice.kind === "work" || voice.kind === "agent"
          ? "deleted"
          : voice.reason;
    }),
  );
  const [reason] = reasons;
  if (reasons.size === 1 && reason === "deleted")
    return plural(count, { one: "# document deleted", other: "# documents deleted" });
  if (reasons.size === 1 && reason === "discarded")
    return plural(count, { one: "# document discarded", other: "# documents discarded" });
  return plural(count, { one: "# document removed", other: "# documents removed" });
}

export function RemovedDocumentSentence({ documents }: { documents: readonly Removal[] }) {
  useLingui();
  return <>{removalSentence(documents)}</>;
}

const EMPTY_NOTICE: RemovedNoticeSnapshot = { shown: [], waiting: [], version: 0 };
const subscribeNothing = () => () => undefined;

/** One surface's removed-documents notice. */
export function useRemovedNotice(projectId: string, surface: NoticeSurface): RemovedNoticeSnapshot {
  const notices = useOptionalRemovedNotices();
  return useSyncExternalStore(
    notices ? (listener) => notices.subscribe(listener) : subscribeNothing,
    () => notices?.snapshot(projectId, surface) ?? EMPTY_NOTICE,
    () => EMPTY_NOTICE,
  );
}

/**
 * The notice lasts until the writer's next navigation, counted from when its
 * placement is first on screen: a removal noticed while the writer is
 * elsewhere waits for them. It anchors once the place no longer shows a
 * removed document (the removal's own navigation is not the writer's), and a
 * later change of place clears it, documents still waiting included. A
 * removal that joins the notice re-anchors it.
 */
export function useRemovedNoticeLifetime(
  projectId: string,
  surface: NoticeSurface,
  place: Readonly<{
    /** Changes with every navigation the writer makes on this surface. */
    key: string;
    onScreen: boolean;
    /** The document the place shows, by route (Editor) or id (dock). */
    showing: Readonly<{ scheme: string | null; path: string | null }> | string | null;
  }>,
): void {
  const notices = useOptionalRemovedNotices();
  const notice = useRemovedNotice(projectId, surface);
  const anchor = useRef<{ version: number; key: string } | null>(null);
  const { key, onScreen } = place;
  const showing = JSON.stringify(place.showing);
  useEffect(() => {
    if (anchor.current?.version !== notice.version) anchor.current = null;
    if (notice.version === 0) return;
    if (anchor.current) {
      if (anchor.current.key === key) return;
      anchor.current = null;
      notices?.dismiss(projectId, surface);
      return;
    }
    const shows: Readonly<{ scheme: string | null; path: string | null }> | string | null =
      JSON.parse(showing);
    const onRemovedDocument = [...notice.shown, ...notice.waiting].some((document) =>
      typeof shows === "string"
        ? document.documentId === shows
        : document.route.scheme === shows?.scheme &&
          trimSlashes(document.route.path) === trimSlashes(shows?.path ?? ""),
    );
    if (onScreen && !onRemovedDocument) anchor.current = { version: notice.version, key };
  }, [key, notice, notices, onScreen, projectId, showing, surface]);
}

const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, "");

/** The notice's dismiss control, shared by every placement. */
function DismissNotice({
  projectId,
  surface,
  className,
}: {
  projectId: string;
  surface: NoticeSurface;
  className?: string;
}) {
  const notices = useOptionalRemovedNotices();
  return (
    <IconButton
      className={className}
      aria-label={t`Dismiss`}
      onClick={() => notices?.dismiss(projectId, surface)}
    >
      <X aria-hidden className="size-3" />
    </IconButton>
  );
}

/**
 * The strip placement: a ghost chip in a header's free end (the Editor's tab
 * strip, or the dock's header beside "Recent"), inside a `RemovedNoticeSlot`.
 * The full sentence shows when the slot has room and the short one
 * ("1 document deleted") otherwise; the tooltip and accessible name always
 * carry the full sentence, every name included.
 */
export function RemovedDocumentChip({
  projectId,
  surface,
}: {
  projectId: string;
  surface: NoticeSurface;
}) {
  const { shown } = useRemovedNotice(projectId, surface);
  if (shown.length === 0) return null;
  return <Chip projectId={projectId} surface={surface} documents={shown} />;
}

function Chip({
  projectId,
  surface,
  documents,
}: {
  projectId: string;
  surface: NoticeSurface;
  documents: readonly ShownRemoval[];
}) {
  useLingui();
  const sentence = removalSentence(documents);
  return (
    <div
      role="status"
      title={sentence}
      data-removed-document-notice
      className="my-1.5 ml-1 flex min-w-0 max-w-[28rem] items-center gap-1.5 rounded-md border border-border border-dashed pr-0.5 pl-2 text-muted-foreground text-xs"
    >
      <Info aria-hidden className="size-3.5 shrink-0" />
      <span className="sr-only">{sentence}</span>
      <span aria-hidden className="min-w-0 truncate @max-[13rem]:hidden">
        {sentence}
      </span>
      <span aria-hidden className="hidden min-w-0 truncate @max-[13rem]:inline">
        {shortRemovalSentence(documents)}
      </span>
      <DismissNotice projectId={projectId} surface={surface} className="size-5 shrink-0" />
    </div>
  );
}

/**
 * A header's free end, where a chip goes: it takes what the row leaves and,
 * while it holds a notice, never less than the short sentence, so tabs scroll
 * before the notice loses its words.
 */
export function RemovedNoticeSlot({ children }: { children?: ReactNode }) {
  return (
    <div className="@container flex min-w-0 flex-1 basis-0 items-stretch has-[[data-removed-document-notice]]:min-w-48">
      {children}
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
  const { shown } = useRemovedNotice(projectId, "editor");
  if (shown.length === 0) return null;
  return <LandingNotice projectId={projectId} documents={shown} className={className} />;
}

function LandingNotice({
  projectId,
  documents,
  className,
}: {
  projectId: string;
  documents: readonly ShownRemoval[];
  className?: string;
}) {
  useLingui();
  const sentence = removalSentence(documents);
  return (
    <div
      role="status"
      data-removed-document-notice
      className={cn("flex items-center gap-2 text-muted-foreground text-sm", className)}
    >
      <p className="min-w-0 truncate" title={sentence}>
        {sentence}
      </p>
      <DismissNotice projectId={projectId} surface="editor" className="size-6 shrink-0" />
    </div>
  );
}

/** The phone's placement: its top bar's notice row, the slot a screen's own failures use. */
export function useRemovedDocumentPhoneNotice(projectId: string) {
  const { shown } = useRemovedNotice(projectId, "editor");
  return shown.length > 0 ? <PhoneNotice projectId={projectId} documents={shown} /> : null;
}

function PhoneNotice({
  projectId,
  documents,
}: {
  projectId: string;
  documents: readonly ShownRemoval[];
}) {
  useLingui();
  return (
    <div role="status" data-removed-document-notice className="flex items-start gap-2 py-1.5">
      <p className="min-w-0 flex-1 py-1 text-foreground text-sm">{removalSentence(documents)}</p>
      <DismissNotice
        projectId={projectId}
        surface="editor"
        className="shrink-0 [@media(pointer:coarse)]:size-11"
      />
    </div>
  );
}
