/**
 * DraftDockMessages — the strip's sentences: the notes the writer reads before
 * any click, and why a command on a file did not land. Wording only; the
 * strip's model decides what is true.
 */
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { RefusalReason, ReviewMessageText } from "@/features/draft-review/ReviewMessageText";
import { displayThreadTitle } from "@/lib/thread-title";
import type { DockNotes } from "./draft-dock-files";
import type { DockFileFailure } from "./useDraftDock";

/** Names joined as the locale does ("A, B, and C"). */
function useJoined() {
  const { i18n } = useLingui();
  return (names: readonly string[]) =>
    new Intl.ListFormat(i18n.locale || undefined, { style: "long", type: "conjunction" }).format(
      names,
    );
}

/**
 * The notes of one file or of the whole strip. `row` is a file's line in the
 * expanded strip, which already names the file and has no commands under it.
 */
export function DockNotesText({ notes, row = false }: { notes: DockNotes; row?: boolean }) {
  const { i18n } = useLingui();
  const joined = useJoined();
  const tiedWith = joined(notes.tiedChats.map((chat) => displayThreadTitle(chat.title)));
  const newNames = joined(notes.newDocuments);
  return (
    <>
      {notes.tiedChanges > 0 ? (
        <p data-draft-dock-note="tie">
          {row
            ? i18n._(
                plural(notes.tiedChanges, {
                  one: `# change also holds an edit from ${tiedWith}.`,
                  other: `# changes also hold edits from ${tiedWith}.`,
                }),
              )
            : i18n._(
                plural(notes.tiedChanges, {
                  one: `# change also holds an edit from ${tiedWith}. Apply and Discard take both.`,
                  other: `# changes also hold edits from ${tiedWith}. Apply and Discard take both.`,
                }),
              )}
        </p>
      ) : null}
      {notes.needsDraftCommand > 0 ? (
        <p data-draft-dock-note="draft-command">
          {i18n._(
            plural(notes.needsDraftCommand, {
              one: "# change needs Apply draft or Discard draft.",
              other: "# changes need Apply draft or Discard draft.",
            }),
          )}
        </p>
      ) : null}
      {notes.newDocuments.length > 0 ? (
        <p data-draft-dock-note="new-document">
          {row
            ? i18n._(
                plural(notes.newDocuments.length, {
                  one: "New document. Review it to apply.",
                  other: "New documents. Review them to apply.",
                }),
              )
            : i18n._(
                plural(notes.newDocuments.length, {
                  one: `${newNames} is a new document. Review it to apply.`,
                  other: `${newNames} are new documents. Review them to apply.`,
                }),
              )}
        </p>
      ) : null}
    </>
  );
}

/** Why a command on a file (or its preview) did not land, in the strip's words. */
export function DockFailureText({
  failure,
  fileName,
}: {
  failure: DockFileFailure;
  fileName: string;
}) {
  // A failure held on the draft itself: a Review that did not open, or a draft-wide command from another surface.
  if (failure.kind === "draft") return <ReviewMessageText failure={failure.failure} />;
  const { code, mode, serverCode, serverReason } = failure.failure;
  switch (code) {
    case "stale":
      return mode === "apply" ? (
        <Trans>This chat's changes in {fileName} were updated. Check them and apply again.</Trans>
      ) : (
        <Trans>This chat's changes in {fileName} were updated. Check them and discard again.</Trans>
      );
    case "gone":
      return <Trans>Those changes are no longer in the draft.</Trans>;
    case "draft-only":
      return <Trans>A new document is handled as a whole. Review it to apply.</Trans>;
    case "unknown":
      return mode === "apply" ? (
        <Trans>
          Couldn't confirm whether these applied. Check what is left before you try again.
        </Trans>
      ) : (
        <Trans>
          Couldn't confirm whether these were discarded. Check what is left before you try again.
        </Trans>
      );
    case "offline":
      return mode === "apply" ? (
        <Trans>Couldn't apply. Check your connection and try again.</Trans>
      ) : (
        <Trans>Couldn't discard. Check your connection and try again.</Trans>
      );
    case "refused":
      return (
        <>
          {mode === "apply" ? (
            <Trans>Couldn't apply this chat's changes.</Trans>
          ) : (
            <Trans>Couldn't discard this chat's changes.</Trans>
          )}
          <RefusalReason serverCode={serverCode} serverReason={serverReason} />
        </>
      );
    case "server-error":
      return mode === "apply" ? (
        <Trans>Couldn't apply this chat's changes. Try again.</Trans>
      ) : (
        <Trans>Couldn't discard this chat's changes. Try again.</Trans>
      );
  }
}
