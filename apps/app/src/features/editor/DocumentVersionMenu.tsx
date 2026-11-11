import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type DocumentDraftHint, workIdOfDraftOwnerKey } from "@meridian/contracts/branches";
import { useDocumentDraftHints } from "@/client/query/useDocumentDraftHints";
import { useWorks } from "@/client/query/useWorks";
import type { ContextTab } from "@/client/stores";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DraftChipFace, draftChipHitClass } from "@/features/draft-review/DraftChip";
import { tabLocation } from "@/features/project/context/identity-location";
import { useAiDraftLauncher } from "@/features/project/review-launch";
import { hintReviewTarget } from "./draft-hint-review";

/**
 * Which version of the open document is showing, at the end of the toolbar row: Live, with
 * every draft of it (a Work's, or a chat's with no Work) one pick away. Picking a draft opens
 * its review.
 */
export function DocumentVersionMenu({ projectId, tab }: { projectId: string; tab: ContextTab }) {
  const { documentId } = tab;
  const hints = useDocumentDraftHints(projectId, documentId, { enabled: tab.kind !== "new" });
  const { works } = useWorks(projectId);
  const { openAiDraft } = useAiDraftLauncher();
  const location = tabLocation(tab);
  if (tab.kind === "new" || !location.path) return null;
  const contextLocation = { scheme: location.scheme, path: location.path };

  const ownerWork = (hint: DocumentDraftHint) => {
    const workId = workIdOfDraftOwnerKey(hint.owner);
    return workId ? works?.find((candidate) => candidate.id === workId) : undefined;
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t`Document version`} className={draftChipHitClass(false)}>
        <DraftChipFace state={hints.length > 0 ? "pending" : "live"} menu>
          <Trans>Live</Trans>
        </DraftChipFace>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem selected>
          <Trans>Live</Trans>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {hints.length > 0 ? <Trans>Drafts</Trans> : <Trans>No drafts</Trans>}
        </DropdownMenuLabel>
        {hints.map((hint) => {
          const target = hintReviewTarget(hint, {
            documentId,
            contextLocation,
            documentName: location.leaf,
          });
          return (
            <DropdownMenuItem
              key={hint.branchId}
              onSelect={() => openAiDraft(target)}
              className="h-auto min-h-8 flex-col items-start gap-0.5"
            >
              <WorkIdentity
                work={ownerWork(hint)}
                unavailableLabel={hint.label || t`Unnamed draft`}
                className="text-sm font-normal"
              />
              {hint.tree ? (
                <span className="text-xs text-muted-foreground">
                  {"deleted" in hint.tree ? (
                    <Trans>Deletes this document</Trans>
                  ) : (
                    <Trans>Moves it to {hint.tree.movedTo.path}</Trans>
                  )}
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
