/**
 * LibraryDetailPane — detail slot for the Library master-detail shell.
 *
 * Agent and skill selections render structured definition editors; package
 * selections show metadata with update/export; install selection opens the
 * in-pane package install flow.
 */
import { Trans } from "@lingui/react/macro";
import type { ProjectLibraryResponse } from "@meridian/contracts/agents";
import { useCallback, useRef } from "react";

import { cn } from "@/lib/utils";

import { AgentDefinitionEditor } from "./editor/AgentDefinitionEditor";
import { SkillDefinitionEditor } from "./editor/SkillDefinitionEditor";
import { PackageInstallFlow } from "./install/PackageInstallFlow";
import { PackageDetailPanel } from "./install/PackageUpdateFlow";
import type { LibrarySelection } from "./library-selection";

export type LibraryDetailPaneProps = {
  projectId: string;
  library: ProjectLibraryResponse;
  selection: LibrarySelection | null;
  className?: string;
  onDirtyChange: (dirty: boolean) => void;
  registerSaveHandler: (handler: (() => Promise<boolean>) | null) => void;
  onClearSelection?: () => void;
  /** TODO(test-loop): parallel lane wires fresh-thread test from the dock. */
  onTestAgent?: (slug: string) => void;
};

export function LibraryDetailPane({
  projectId,
  library,
  selection,
  className,
  onDirtyChange,
  registerSaveHandler,
  onClearSelection,
  onTestAgent,
}: LibraryDetailPaneProps) {
  const saveHandlerRef = useRef<(() => Promise<boolean>) | null>(null);

  const registerEditorSave = useCallback(
    (handler: (() => Promise<boolean>) | null) => {
      saveHandlerRef.current = handler;
      registerSaveHandler(handler);
    },
    [registerSaveHandler],
  );

  if (!selection) {
    return (
      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground",
          className,
        )}
      >
        <Trans>Select an agent or skill</Trans>
      </div>
    );
  }

  if (selection.kind === "install") {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <PackageInstallFlow projectId={projectId} onCancel={() => onClearSelection?.()} />
      </div>
    );
  }

  if (selection.kind === "agent") {
    const agent = library.agents.find((row) => row.slug === selection.slug);
    if (!agent) return <MissingSelection className={className} />;
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <AgentDefinitionEditor
          projectId={projectId}
          summary={agent}
          onDirtyChange={onDirtyChange}
          registerSaveHandler={registerEditorSave}
          onTestAgent={onTestAgent ? () => onTestAgent(agent.slug) : undefined}
        />
      </div>
    );
  }

  if (selection.kind === "skill") {
    const skill = library.skills.find((row) => row.slug === selection.slug);
    if (!skill) return <MissingSelection className={className} />;
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <SkillDefinitionEditor
          projectId={projectId}
          summary={skill}
          onDirtyChange={onDirtyChange}
          registerSaveHandler={registerEditorSave}
        />
      </div>
    );
  }

  const pkg = library.packages.find((row) => row.slug === selection.slug);
  if (!pkg) return <MissingSelection className={className} />;
  return (
    <PackageDetailPanel projectId={projectId} pkg={pkg} library={library} className={className} />
  );
}

function MissingSelection({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground",
        className,
      )}
    >
      <Trans>Selection is no longer available</Trans>
    </div>
  );
}
