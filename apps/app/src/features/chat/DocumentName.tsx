import { t } from "@lingui/core/macro";
import { MIDDLE_BUTTON } from "@/core/editor/links";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { useOpenPlacedDocument } from "@/features/project/review-launch";
import { contextUriFromWritePath } from "@/lib/context-uri";
import { useChatContextNavigation, useChatContextRoutability } from "./ChatContextNavigation";
import { documentDisplayName } from "./document-display-name";

export type DocumentNameProps = {
  path: string;
  insideDoor?: boolean;
  label?: "name" | "open";
  name?: string;
  documentId?: string;
};

export function DocumentName({
  path,
  insideDoor = false,
  label = "name",
  name: shownName,
  documentId,
}: DocumentNameProps) {
  const projectId = useProjectDocumentNavigationProjectId();
  const openPlaced = useOpenPlacedDocument(projectId ?? undefined);
  const openContextUri = useChatContextNavigation();
  const canOpenContextUri = useChatContextRoutability();
  const title = shownName ?? documentDisplayName(path);

  const uri = contextUriFromWritePath(path);
  const byIdentity = documentId !== undefined && projectId !== null;
  const isDoor =
    byIdentity ||
    (uri !== null && !insideDoor && openContextUri !== null && canOpenContextUri?.(uri) === true);
  const open = () => {
    if (byIdentity) void openPlaced(documentId);
    else if (uri !== null) openContextUri?.(uri, undefined);
  };

  const openLabel = t`Open ${title}`;
  const name = <span className="min-w-0 truncate">{label === "open" ? openLabel : title}</span>;

  if (!isDoor) {
    return <span className="flex min-w-0 items-baseline text-foreground">{name}</span>;
  }

  return (
    <button
      type="button"
      aria-label={openLabel}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
      onAuxClick={(event) => {
        if (event.button !== MIDDLE_BUTTON) return;
        event.stopPropagation();
        open();
      }}
      className="focus-ring relative z-10 -my-2 flex min-w-0 items-baseline rounded-sm py-[var(--chat-space-block)] text-left text-muted-foreground underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-jade-text hover:decoration-jade-text focus-visible:text-jade-text focus-visible:decoration-jade-text"
    >
      {name}
    </button>
  );
}
