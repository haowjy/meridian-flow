/**
 * Which version of the open document its view shows, as one chip and menu on desktop and phone:
 * Live, or a draft, with every owner's draft of the document one pick away. It reads the host's
 * paint (`useDocumentPaint`) and the document's draft hints, and writes the document's view: a
 * picked draft becomes the view's pin, Live drops it. `DraftSwitcher` draws it.
 *
 * In review the host passes the review's own controls (`review`): its lock, the draft-only way
 * out, and the phone's Apply, Discard and Show changes.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type DocumentDraftHint, workIdOfDraftOwnerKey } from "@meridian/contracts/branches";
import { setDocumentView } from "@/client/project-shell/document-views";
import { useDocumentDraftHints } from "@/client/query/useDocumentDraftHints";
import { useWorks } from "@/client/query/useWorks";
import type { OpenDocument } from "@/client/stores";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import { DraftSwitcher, type DraftSwitcherProps } from "@/features/draft-review/DraftSwitcher";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { useHostDocumentPaint } from "@/features/project/DocumentReview";
import { useShellTreeVersion } from "@/features/project/tree-version";
import { escapeCssIdent } from "@/lib/css-selector";
import { holdFocus } from "@/lib/focus-follow";
import { workDisplayName } from "@/lib/work-name";

export type DocumentVersionReview = Pick<
  DraftSwitcherProps,
  "disabled" | "draftOnly" | "onShowLive" | "onRename" | "marks" | "draftCommands"
>;

export function DocumentVersionMenu({
  projectId,
  document,
  touch = false,
  review,
}: {
  projectId: string;
  document: OpenDocument;
  touch?: boolean;
  /** The open review's controls; absent while the document shows Live. */
  review?: DocumentVersionReview;
}) {
  const { documentId } = document;
  const accountId = useAccountId();
  const paint = useHostDocumentPaint();
  // The chip and the sidebar's Live/Draft toggle are one state (`shownDraft`): a pick here sets it.
  const shell = useShellTreeVersion();
  const hints = useDocumentDraftHints(projectId, documentId, { enabled: document.kind !== "new" });
  const { works } = useWorks(projectId);
  if (document.kind === "new") return null;

  const shown = review ? (paint?.draft ?? null) : null;
  const ownerWork = (owner: string) => {
    const workId = workIdOfDraftOwnerKey(owner);
    return workId ? works?.find((candidate) => candidate.id === workId) : undefined;
  };
  const ownerName = (owner: string, label: string | null) => {
    const work = ownerWork(owner);
    return work ? workDisplayName(work) : label;
  };
  const listed: Pick<DocumentDraftHint, "owner" | "itemKey" | "label" | "tree">[] = [...hints];
  // A draft on screen that the hints have not caught up with is still a version of the document.
  if (shown && !hints.some((hint) => hint.owner === shown.ownerKey))
    listed.push({
      owner: shown.ownerKey as DocumentDraftHint["owner"],
      itemKey: shown.itemKey as DocumentDraftHint["itemKey"],
      label: null,
      tree: null,
    });
  const scopeOwner = paint?.scopeOwnerKey ?? null;

  const drafts = listed.map((hint) => ({
    key: `${hint.owner}:${hint.itemKey}`,
    name: (
      <WorkIdentity
        work={ownerWork(hint.owner)}
        unavailableLabel={hint.label || t`Unnamed draft`}
        className="text-sm font-normal"
      />
    ),
    detail: hint.tree ? (
      "deleted" in hint.tree ? (
        <Trans>Deletes this document</Trans>
      ) : (
        <Trans>Moves it to {hint.tree.movedTo.path}</Trans>
      )
    ) : undefined,
    current: shown?.ownerKey === hint.owner,
    scope: hint.owner === scopeOwner,
    onSelect: () => {
      // The toggle's Work's draft is that Work's version of every page: the toggle goes to Draft.
      if (hint.owner === shell?.ownerKey) shell.show("draft");
      else
        setDocumentView(accountId, projectId, documentId, {
          pin: { ownerKey: hint.owner, itemKey: hint.itemKey },
        });
      followToChip(documentId);
    },
  }));
  const shownLabel = listed.find((hint) => hint.owner === shown?.ownerKey)?.label ?? null;
  const outOfScope =
    shown && paint?.outOfScope ? (ownerName(shown.ownerKey, shownLabel) ?? t`Unnamed draft`) : null;

  return (
    <DraftSwitcher
      // An ended draft's review stays open ("No changes left") while main paints Live.
      showing={review && paint?.showing !== "live" ? "draft" : "live"}
      drafts={drafts}
      owner={outOfScope ?? undefined}
      draftOnly={review?.draftOnly ?? false}
      disabled={review?.disabled ?? false}
      onShowLive={() => {
        if (review) review.onShowLive();
        else setDocumentView(accountId, projectId, documentId, { version: "live" });
        shell?.show("live");
        followToChip(documentId);
      }}
      onRename={review?.onRename}
      marks={review?.marks}
      draftCommands={review?.draftCommands}
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
