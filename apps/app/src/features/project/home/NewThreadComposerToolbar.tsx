/** Prospective Agent, write-mode, and Work controls for a not-yet-created chat. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { useEffect, useRef, useState } from "react";
import {
  ComposerCurrentValueTrigger,
  ComposerToolbar,
  type ComposerToolbarControl,
  createComposerToolbarModel,
} from "@/components/app/composer-toolbar";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import {
  deriveWorkPickerViewModel,
  useSelectedWorkWriteModeToolbarControl,
  WorkPickerPanel,
} from "@/components/app/work-composer-controls";
import { useComposerAgentToolbarControl } from "@/features/agents/ComposerAgentControl";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";

export function NewThreadComposerToolbar({
  projectId,
  work,
  selectedWorkId,
  works,
  worksStatus,
  agentSlug,
  disabled,
  onAgentChange,
  onWorkChange,
  onRetryWorks,
  onModePendingChange,
}: {
  projectId: string;
  work: Work | null;
  selectedWorkId: string | null;
  works: Work[];
  worksStatus: "loading" | "error" | "ready";
  agentSlug: string;
  disabled: boolean;
  onAgentChange(slug: string): void;
  onWorkChange(work: Work): void;
  onRetryWorks(): void;
  onModePendingChange(pending: boolean): void;
}) {
  const agentControl = useComposerAgentToolbarControl({
    projectId,
    mode: "interactive",
    selectedSlug: agentSlug,
    onSelectedSlugChange: onAgentChange,
  });
  const agent = disabled ? { ...agentControl, interaction: "busy" as const } : agentControl;
  const workControl = useProspectiveWorkControl({
    work,
    selectedWorkId,
    works,
    worksStatus,
    disabled,
    onWorkChange,
    onRetryWorks,
  });
  useEffect(() => {
    if (!work) onModePendingChange(false);
  }, [onModePendingChange, work]);
  if (!work) {
    return (
      <ComposerToolbar
        ariaLabel={t`Composer controls`}
        model={createComposerToolbarModel([agent, workControl])}
      />
    );
  }
  return (
    <AvailableNewThreadControls
      projectId={projectId}
      work={work}
      agent={agent}
      workControl={workControl}
      disabled={disabled}
      onModePendingChange={onModePendingChange}
    />
  );
}

function AvailableNewThreadControls({
  projectId,
  work,
  agent,
  workControl,
  disabled,
  onModePendingChange,
}: {
  projectId: string;
  work: Work;
  agent: ComposerToolbarControl;
  workControl: ComposerToolbarControl;
  disabled: boolean;
  onModePendingChange(pending: boolean): void;
}) {
  const { openAiDraft } = useAiDraftLauncher();
  const mode = useSelectedWorkWriteModeToolbarControl({
    projectId,
    work,
    openDraftReview: (group, draftId) => {
      if (!group.contextPath) return;
      openAiDraft({ ...group, workId: work.id, draftId, contextPath: group.contextPath });
    },
  });
  const modePending = "interaction" in mode && mode.interaction === "busy";
  const visibleMode = disabled ? { ...mode, interaction: "busy" as const } : mode;
  useEffect(() => onModePendingChange(modePending), [modePending, onModePendingChange]);
  return (
    <ComposerToolbar
      ariaLabel={t`Composer controls`}
      model={createComposerToolbarModel([agent, visibleMode, workControl])}
    />
  );
}

function useProspectiveWorkControl({
  work,
  selectedWorkId,
  works,
  worksStatus,
  disabled,
  onWorkChange,
  onRetryWorks,
}: {
  work: Work | null;
  selectedWorkId: string | null;
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
  const label = work
    ? t`Choose Work for new chat, currently ${work.name}`
    : t`Choose Work for new chat, current choice unavailable`;
  return {
    kind: "panel",
    id: "work",
    priority: 100,
    interaction: disabled ? "busy" : "enabled",
    item: {
      ariaLabel: label,
      label: <Trans>Work</Trans>,
      value: work?.name ?? t`Unavailable`,
    },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger binding={trigger} ariaLabel={label}>
        <WorkIdentity name={work?.name} unavailableLabel={t`Unavailable`} />
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
                { key: `selected:${selectedWorkId ?? "none"}`, ref: selectedRef },
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
          operation={{
            currentWorkId: selectedWorkId ?? "",
            targetId: null,
            pending: false,
            failure: null,
          }}
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
