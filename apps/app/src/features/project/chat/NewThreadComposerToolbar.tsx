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
import type { CreationAgent } from "@/features/agents/creation-agent";

export function NewThreadComposerToolbar({
  projectId,
  work,
  selectedWorkId,
  works,
  noWork,
  worksStatus,
  agent: selectedAgent,
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
  noWork: Work | null;
  worksStatus: "loading" | "error" | "ready";
  agent: CreationAgent | null;
  disabled: boolean;
  onAgentChange(agent: CreationAgent): void;
  onWorkChange(work: Work): void;
  onRetryWorks(): void;
  onModePendingChange(pending: boolean): void;
}) {
  const agentControl = useComposerAgentToolbarControl({
    mode: "interactive",
    projectId,
    selectedAgent,
    onSelectedAgentChange: onAgentChange,
  });
  const agent = disabled ? { ...agentControl, interaction: "busy" as const } : agentControl;
  const workControl = useProspectiveWorkControl({
    work,
    selectedWorkId,
    works,
    noWork,
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
  const mode = useSelectedWorkWriteModeToolbarControl({
    projectId,
    work,
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
  noWork,
  worksStatus,
  disabled,
  onWorkChange,
  onRetryWorks,
}: {
  work: Work | null;
  selectedWorkId: string | null;
  works: Work[];
  noWork: Work | null;
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
    worksStatus === "error"
      ? { status: "error" as const, retry: onRetryWorks }
      : worksStatus === "loading" || !noWork
        ? { status: "loading" as const }
        : { status: "ready" as const, works, noWork, refreshing: false };
  const view = deriveWorkPickerViewModel(catalog, query, disabled);

  const unavailableLabel = selectedWorkId && !work?.isNoWork ? t`Unavailable Work` : t`No Work`;
  const label = work
    ? t`Choose Work for new chat, currently ${work.name}`
    : t`Choose Work for new chat, currently ${unavailableLabel}`;
  return {
    kind: "panel",
    id: "work",
    priority: 100,
    interaction: disabled ? "busy" : "enabled",
    item: {
      ariaLabel: label,
      label: <Trans>Work</Trans>,
      value: work?.name ?? unavailableLabel,
    },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger binding={trigger} ariaLabel={label}>
        <WorkIdentity name={work?.name} unavailableLabel={unavailableLabel} />
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
                { key: `selected:${selectedWorkId}`, ref: selectedRef },
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
            currentWorkId: selectedWorkId,
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
