import { t } from "@lingui/core/macro";
import { Layers } from "lucide-react";
import { useRef, useState } from "react";
import { useProjectTrees } from "@/client/query/useProjectTrees";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import { dropdownSurfaceVariants } from "@/components/ui/dropdown-presentation";
import { ListRow } from "@/components/ui/list-row";
import { ChooserMark } from "@/components/ui/marks";
import { PickerSection } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { documentDisplayName } from "@/features/chat/document-display-name";
import { DocumentChoices } from "@/features/project/side/DocumentChoices";
import { useShellTreeVersion } from "@/features/project/tree-version";
import { cn } from "@/lib/utils";
import { workDraftName } from "./draft-names";
import type { ReviewMode } from "./review-mode";
import { referenceOf } from "./use-review-reference";

export function ReviewTargetPicker({ mode }: { mode: ReviewMode }) {
  const densityPopoverCollisionProps = useDensityPopoverCollisionProps();
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const shell = useShellTreeVersion();
  const trees = useProjectTrees(mode.projectId);
  const workDrafts = shell?.workDrafts?.drafts ?? [];
  const others = workDrafts.some((draft) => draft.id === mode.draftId)
    ? workDrafts.filter((draft) => draft.id !== mode.draftId)
    : [];
  const target = referenceOf(mode.target);
  const fileName = (documentId: string) => {
    const uri = trees.find(documentId)?.file.uri;
    return uri ? documentDisplayName(uri) : t`another file`;
  };
  const name =
    target.kind === "live"
      ? t`Live`
      : target.kind === "draft"
        ? (() => {
            const draft = workDrafts.find((each) => each.id === target.draftId);
            return draft ? workDraftName(draft) : t`another draft`;
          })()
        : fileName(target.documentId);
  const pick = (next: string) => {
    setOpen(false);
    if (next !== mode.target) mode.retarget(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-review-target={mode.target}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="focus-ring inline-flex min-w-0 shrink items-center gap-1 rounded-sm px-1.5 text-xs text-muted-foreground hover:bg-ink-fill hover:text-foreground coarse:min-h-11"
        >
          <span className="min-w-0 truncate">{t`against ${name}`}</span>
          <ChooserMark />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...densityPopoverCollisionProps}
        align="start"
        className={cn(
          dropdownSurfaceVariants({ measure: "catalog" }),
          "flex max-h-[min(32rem,70vh)]",
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        {open ? (
          <DocumentChoices
            projectId={mode.projectId}
            current={target.kind === "file" ? target.documentId : null}
            searchRef={searchRef}
            choose={(documentId) =>
              pick(documentId === mode.documentId ? "live" : `file:${documentId}`)
            }
            lead={
              <PickerSection label={t`Compare with`}>
                <li>
                  <ListRow
                    density="menu"
                    current={target.kind === "live"}
                    onOpen={() => pick("live")}
                    title={t`Live`}
                  />
                </li>
                {others.map((draft) => (
                  <li key={draft.id}>
                    <ListRow
                      density="menu"
                      current={target.kind === "draft" && target.draftId === draft.id}
                      onOpen={() => pick(draft.id)}
                      leading={
                        <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      }
                      title={workDraftName(draft)}
                    />
                  </li>
                ))}
              </PickerSection>
            }
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
