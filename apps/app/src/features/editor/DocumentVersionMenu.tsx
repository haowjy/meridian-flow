/**
 * Which version of the open document its view shows, as one chip and menu on desktop and phone:
 * Live, or a draft, with every draft of the document one pick away. It reads the host's
 * paint (`useDocumentPaint`) and the document's draft hints, and writes the document's view: another
 * owner's picked draft becomes the view's pin; the scope's own draft and Live set the sidebar
 * toggle and drop the pin. `DraftSwitcher` draws it.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { DocumentDraftHint } from "@meridian/contracts/drafts";
import { setDocumentView } from "@/client/project-shell/document-views";
import { useDocumentDraftHints } from "@/client/query/useDocumentDraftHints";
import { useWorks } from "@/client/query/useWorks";
import type { OpenDocument } from "@/client/stores";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import { DraftSwitcher } from "@/features/draft-review/DraftSwitcher";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { useHostDocumentPaint } from "@/features/project/DocumentReview";
import { useShellTreeVersion } from "@/features/project/tree-version";
import { escapeCssIdent } from "@/lib/css-selector";
import { holdFocus } from "@/lib/focus-follow";

export function DocumentVersionMenu({
  projectId,
  document,
  touch = false,
}: {
  projectId: string;
  document: OpenDocument;
  touch?: boolean;
}) {
  const { documentId } = document;
  const accountId = useAccountId();
  const paint = useHostDocumentPaint();
  // The chip and the sidebar's Live/Draft toggle are one state (`shownDraft`): a pick here sets it.
  const shell = useShellTreeVersion();
  const hints = useDocumentDraftHints(projectId, documentId, { enabled: document.kind !== "new" });
  const { works, nameOf } = useWorks(projectId);
  if (document.kind === "new") return null;

  // The chip reads the paint, the one version rule, never whether the review's controls are up:
  // a draft whose room is still opening is already the version on screen.
  const shown = paint?.draft ?? null;
  const draftWork = (draft: string) => works?.find((candidate) => candidate.draftId === draft);
  const draftName = (draft: string, label: string | null) => {
    const work = draftWork(draft);
    return work ? nameOf(work) : label;
  };
  const listed: DocumentDraftHint[] = [...hints];
  // A draft on screen that the hints have not caught up with is still a version of the document.
  if (shown && !hints.some((hint) => hint.draftId === shown.draftId))
    listed.push({
      draftId: shown.draftId,
      itemKey: shown.itemKey as DocumentDraftHint["itemKey"],
      label: null,
      tree: null,
    });
  const scopeDraft = paint?.scopeDraftId ?? null;

  const drafts = listed.map((hint) => ({
    key: hint.itemKey,
    name: (
      <WorkIdentity
        work={draftWork(hint.draftId)}
        unavailableLabel={hint.label || t`Unnamed draft`}
      />
    ),
    detail: hint.tree ? (
      "deleted" in hint.tree ? (
        <Trans>Deletes this document</Trans>
      ) : (
        <Trans>Moves it to {hint.tree.movedTo.path}</Trans>
      )
    ) : undefined,
    current: shown?.draftId === hint.draftId,
    scope: hint.draftId === scopeDraft,
    onSelect: () => {
      // The toggle's Work's draft is that Work's version of every page: the toggle goes to Draft,
      // and another owner's pin, which outranks the toggle, goes.
      const scoped = hint.draftId === shell?.draftId;
      if (scoped) shell.show("draft");
      setDocumentView(accountId, projectId, documentId, {
        pin: scoped ? null : { draftId: hint.draftId, itemKey: hint.itemKey },
      });
      followToChip(documentId);
    },
  }));
  // As the sidebar's chip shows only while there is a draft to switch to, this one shows only
  // while the document has a version besides the one on screen.
  const showing = paint && paint.showing !== "live" ? "draft" : "live";
  if (showing === "live" && drafts.length === 0) return null;
  const shownLabel = listed.find((hint) => hint.draftId === shown?.draftId)?.label ?? null;
  const outOfScope =
    shown && paint?.outOfScope ? (draftName(shown.draftId, shownLabel) ?? t`Unnamed draft`) : null;

  return (
    <DraftSwitcher
      showing={showing}
      drafts={drafts}
      owner={outOfScope ?? undefined}
      onShowLive={() => {
        setDocumentView(accountId, projectId, documentId, { version: "live" });
        shell?.show("live");
        followToChip(documentId);
      }}
      touch={touch}
    />
  );
}

/** A pick swaps the chip for the other version's: the menu's focus return follows to the new one. */
function followToChip(documentId: string) {
  holdFocus(() =>
    document.querySelector<HTMLElement>(
      `[data-project-host="document:${escapeCssIdent(documentId)}"] [data-version-chip]`,
    ),
  );
}
