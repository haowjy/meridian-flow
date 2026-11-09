import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { DocumentDraftHint } from "@meridian/contracts/branches";
import { Check, ChevronDown } from "lucide-react";
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
import { tabLocation } from "@/features/project/context/identity-location";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { workDisplayName } from "@/lib/work-name";
import { hintReviewTarget } from "./draft-hint-review";

/**
 * Which version of the open document is showing, at the end of the toolbar row: Live, with
 * every Work that has a draft of it one pick away. Picking a draft opens its review.
 */
export function DocumentVersionMenu({ projectId, tab }: { projectId: string; tab: ContextTab }) {
  const { documentId } = tab;
  const hints = useDocumentDraftHints(projectId, documentId, { enabled: tab.kind !== "new" });
  const { works } = useWorks(projectId);
  const { openAiDraft } = useAiDraftLauncher();
  const location = tabLocation(tab);
  if (tab.kind === "new" || !location.path) return null;
  const contextLocation = { scheme: location.scheme, path: location.path };

  const workName = (hint: DocumentDraftHint) => {
    const work = works?.find((candidate) => candidate.id === hint.originWorkId);
    return work ? workDisplayName(work) : hint.label;
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Document version`}
        className="focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-muted hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
      >
        <Trans>Live</Trans>
        {hints.length > 0 ? (
          <span
            className="rounded-full bg-primary/12 px-1.5 text-[11px] font-medium text-primary tabular-nums"
            title={t`${hints.length} drafts`}
          >
            {hints.length}
          </span>
        ) : null}
        <ChevronDown aria-hidden className="size-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem aria-current="true" className="gap-2 font-medium">
          <Check aria-hidden className="size-3.5 text-primary" />
          <Trans>Live</Trans>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">
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
              disabled={!target}
              onSelect={() => target && openAiDraft(target)}
              className="flex-col items-start gap-0.5 pl-7"
            >
              <WorkIdentity
                name={workName(hint)}
                unavailableLabel={t`Unnamed Work`}
                className="text-[13px] font-normal"
              />
              {hint.tree ? (
                <span className="text-xs text-ink-muted">
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
