/** Prospective Agent, write-mode, and Work controls for a not-yet-created chat. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AiWriteMode, Work } from "@meridian/contracts/works";
import { useRef, useState } from "react";
import {
  ComposerCurrentValueTrigger,
  ComposerToolbar,
  type ComposerToolbarControl,
  createComposerToolbarModel,
} from "@/components/app/composer-toolbar";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import {
  deriveWorkPickerViewModel,
  useWriteModeToolbarControl,
  WorkPickerPanel,
} from "@/components/app/work-composer-controls";
import { useComposerAgentToolbarControl } from "@/features/agents/ComposerAgentControl";
import type { CreationAgent } from "@/features/agents/creation-agent";
import { workDisplayName } from "@/lib/work-name";

export function NewThreadComposerToolbar({
  projectId,
  work,
  selectedWorkId,
  works,
  noWork,
  worksStatus,
  agent: selectedAgent,
  writeMode,
  onAgentChange,
  onWorkChange,
  onWriteModeChange,
  onRetryWorks,
}: {
  projectId: string;
  work: Work | null;
  selectedWorkId: string | null;
  works: Work[];
  noWork: Work | null;
  worksStatus: "loading" | "error" | "ready";
  agent: CreationAgent | null;
  /** The selected Work's default, or the mode the writer chose in this composer. */
  writeMode: AiWriteMode;
  onAgentChange(agent: CreationAgent): void;
  onWorkChange(work: Work): void;
  onWriteModeChange(mode: AiWriteMode): void;
  onRetryWorks(): void;
}) {
  const agent = useComposerAgentToolbarControl({
    mode: "interactive",
    projectId,
    selectedAgent,
    onSelectedAgentChange: onAgentChange,
  });
  const workControl = useProspectiveWorkControl({
    work,
    selectedWorkId,
    works,
    noWork,
    worksStatus,
    onWorkChange,
    onRetryWorks,
  });
  const mode = useWriteModeToolbarControl({ value: writeMode, onChoose: onWriteModeChange });
  return (
    <ComposerToolbar
      ariaLabel={t`Composer controls`}
      model={createComposerToolbarModel(work ? [agent, mode, workControl] : [agent, workControl])}
    />
  );
}

function useProspectiveWorkControl({
  work,
  selectedWorkId,
  works,
  noWork,
  worksStatus,
  onWorkChange,
  onRetryWorks,
}: {
  work: Work | null;
  selectedWorkId: string | null;
  works: Work[];
  noWork: Work | null;
  worksStatus: "loading" | "error" | "ready";
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
  const view = deriveWorkPickerViewModel(catalog, query, false);

  const unavailableLabel = selectedWorkId && !work?.isNoWork ? t`Unavailable Work` : t`None`;
  const name = work ? workDisplayName(work) : unavailableLabel;
  const label = t`Choose Work for new chat, currently ${name}`;
  return {
    kind: "panel",
    id: "work",
    priority: 100,
    interaction: "enabled",
    item: {
      ariaLabel: label,
      label: <Trans>Work</Trans>,
      value: name,
    },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger binding={trigger} ariaLabel={label}>
        <WorkIdentity work={work} unavailableLabel={unavailableLabel} />
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
