/** Prospective Agent, write-mode, and Work controls for a not-yet-created chat. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { useRef, useState } from "react";
import {
  ComposerCurrentValueTrigger,
  ComposerToolbar,
  type ComposerToolbarControl,
  createComposerToolbarModel,
} from "@/components/app/composer-toolbar";
import { useComposerAgentToolbarControl } from "@/features/agents/ComposerAgentControl";
import { useComposerWriteModeToolbarControl } from "@/features/chat/ComposerWriteModeControl";
import { deriveWorkPickerViewModel, WorkPickerPanel } from "@/features/chat/WorkPickerPanel";

export function NewThreadComposerToolbar({
  projectId,
  work,
  works,
  worksStatus,
  agentSlug,
  disabled,
  onAgentChange,
  onWorkChange,
  onRetryWorks,
}: {
  projectId: string;
  work: Work;
  works: Work[];
  worksStatus: "loading" | "error" | "ready";
  agentSlug: string;
  disabled: boolean;
  onAgentChange(slug: string): void;
  onWorkChange(work: Work): void;
  onRetryWorks(): void;
}) {
  const agent = useComposerAgentToolbarControl({
    projectId,
    mode: "interactive",
    selectedSlug: agentSlug,
    onSelectedSlugChange: onAgentChange,
  });
  const mode = useComposerWriteModeToolbarControl({ projectId, work });
  const workControl = useProspectiveWorkControl({
    work,
    works,
    worksStatus,
    disabled,
    onWorkChange,
    onRetryWorks,
  });
  return (
    <ComposerToolbar
      ariaLabel={t`Composer controls`}
      model={createComposerToolbarModel([agent, mode, workControl])}
    />
  );
}

function useProspectiveWorkControl({
  work,
  works,
  worksStatus,
  disabled,
  onWorkChange,
  onRetryWorks,
}: {
  work: Work;
  works: Work[];
  worksStatus: "loading" | "error" | "ready";
  disabled: boolean;
  onWorkChange(work: Work): void;
  onRetryWorks(): void;
}): ComposerToolbarControl {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const catalog =
    worksStatus === "loading"
      ? { status: "loading" as const }
      : worksStatus === "error"
        ? { status: "error" as const, retry: onRetryWorks }
        : { status: "ready" as const, works, refreshing: false };
  const view = deriveWorkPickerViewModel(catalog, query, disabled);
  const label = t`Choose Work for new chat, currently ${work.name}`;
  return {
    kind: "panel",
    id: "work",
    priority: 100,
    interaction: disabled ? "busy" : "enabled",
    item: { ariaLabel: label, label: <Trans>Work</Trans>, value: work.name },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger binding={trigger} ariaLabel={label}>
        {work.name}
      </ComposerCurrentValueTrigger>
    ),
    panel: {
      ariaLabel: t`Choose Work for new chat`,
      size: "catalog",
      focus: {
        pageId: view.status,
        repairRevision: [query, view.enabled, ...view.enabledIds].join("\0"),
        candidates:
          view.status === "ready"
            ? [
                { key: "search", ref: searchRef },
                { key: `selected:${work.id}`, ref: selectedRef },
                { key: `first:${view.enabledIds[0] ?? "none"}`, ref: firstRef },
              ]
            : view.status === "error"
              ? [{ key: "retry", ref: retryRef }]
              : [],
        fallback: "content",
      },
      render: ({ terminalClose }) => (
        <WorkPickerPanel
          purposeLabel={t`Choose Work for new chat`}
          view={view}
          operation={{ currentWorkId: work.id, targetId: null, pending: false, failure: null }}
          onQueryChange={setQuery}
          onChoose={(next) => {
            onWorkChange(next);
            terminalClose();
          }}
          searchRef={searchRef}
          focusRefs={{ selected: selectedRef, first: firstRef, retry: retryRef }}
        />
      ),
    },
  };
}
