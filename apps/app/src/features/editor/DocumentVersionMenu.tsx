import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { DocumentDraftHint } from "@meridian/contracts/drafts";
import { setDocumentView } from "@/client/project-shell/document-views";
import { useDocumentDraftHints } from "@/client/query/useDocumentDraftHints";
import { useDraftOnly } from "@/client/query/useOwnerDrafts";
import { useWorks } from "@/client/query/useWorks";
import type { OpenDocument } from "@/client/stores";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import { DraftSwitcher } from "@/features/draft-review/DraftSwitcher";
import { useWorkDraftMenu } from "@/features/draft-review/work-draft-menu";
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
  const shell = useShellTreeVersion();
  const hints = useDocumentDraftHints(projectId, documentId, { enabled: document.kind !== "new" });
  const { works, nameOf } = useWorks(projectId);
  const shown = paint?.draft ?? null;
  const menu = useWorkDraftMenu(projectId, shell, (draftId) => shown?.draftId === draftId);
  const draftOnly = useDraftOnly(projectId, shown?.draftId ?? null)(documentId);
  if (document.kind === "new") return null;

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

  const workDraftIds = new Set(menu?.drafts.map((draft) => draft.key));
  const detailOf = (hint: DocumentDraftHint) =>
    hint.tree ? (
      "deleted" in hint.tree ? (
        <Trans>Deletes this document</Trans>
      ) : (
        <Trans>Moves it to {hint.tree.movedTo.path}</Trans>
      )
    ) : undefined;
  const workEntries = (menu?.drafts ?? []).map((draft) => {
    const hint = listed.find((each) => each.draftId === draft.key);
    return {
      ...draft,
      detail: hint ? detailOf(hint) : undefined,
      onSelect: () => {
        draft.onSelect();
        setDocumentView(accountId, projectId, documentId, { pin: null });
        followToChip(documentId);
      },
    };
  });
  const hinted = listed
    .filter((hint) => !workDraftIds.has(hint.draftId))
    .map((hint) => ({
      key: hint.itemKey,
      name: (
        <WorkIdentity
          work={draftWork(hint.draftId)}
          unavailableLabel={hint.label || t`Unnamed draft`}
        />
      ),
      detail: detailOf(hint),
      current: shown?.draftId === hint.draftId,
      scope: hint.draftId === scopeDraft,
      onSelect: () => {
        const scoped = hint.draftId === shell?.draftId;
        if (scoped) shell.show("draft");
        setDocumentView(accountId, projectId, documentId, {
          pin: scoped ? null : { draftId: hint.draftId, itemKey: hint.itemKey },
        });
        followToChip(documentId);
      },
    }));
  const drafts = [...workEntries, ...hinted];
  const showing = paint?.draft ? "draft" : "live";
  if (showing === "live" && drafts.length === 0) return null;
  const shownLabel = listed.find((hint) => hint.draftId === shown?.draftId)?.label ?? null;
  const workDraft = menu?.drafts.find((draft) => draft.key === shown?.draftId);
  const outOfScope =
    shown && paint?.outOfScope && !workDraft
      ? (draftName(shown.draftId, shownLabel) ?? t`Unnamed draft`)
      : null;

  return (
    <DraftSwitcher
      showing={showing}
      drafts={drafts}
      owner={outOfScope ?? menu?.owner}
      onShowLive={
        draftOnly
          ? undefined
          : () => {
              setDocumentView(accountId, projectId, documentId, { version: "live" });
              shell?.show("live");
              followToChip(documentId);
            }
      }
      onNewDraft={menu?.onNewDraft}
      onDeleteDraft={
        menu?.onDeleteDraft && shown?.draftId === shell?.draftId ? menu.onDeleteDraft : undefined
      }
      touch={touch}
    />
  );
}

function followToChip(documentId: string) {
  holdFocus(() =>
    document.querySelector<HTMLElement>(
      `[data-project-host="document:${escapeCssIdent(documentId)}"] [data-version-chip]`,
    ),
  );
}
