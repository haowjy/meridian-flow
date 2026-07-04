/**
 * LibraryScreen — master-detail inventory for agents, skills, and packages.
 *
 * Master-detail Library over `ProjectLibraryResponse`: grouped inventory on
 * the left, structured agent/skill editors on the right. Package install and
 * agent creation affordances remain stubbed for parallel lanes.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type {
  LibraryAgentSummary,
  LibraryPackageSummary,
  LibrarySkillSummary,
  ProjectLibraryResponse,
} from "@meridian/contracts/agents";
import { Plus } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";

import { useProjectLibrary } from "@/client/query/useProjectLibrary";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentChip } from "@/features/agents";
import { cn } from "@/lib/utils";
import { UnsavedChangesDialog } from "./editor/UnsavedChangesDialog";
import { groupBySource } from "./group-inventory";
import { LibraryDetailPane } from "./LibraryDetailPane";
import { type LibrarySelection, selectionKey } from "./library-selection";

export type LibraryScreenProps = {
  projectId: string;
  /** "Test this agent" — creates a fresh bound thread and points the dock at it. */
  onTestAgent?: (slug: string) => void;
};

export function LibraryScreen({ projectId, onTestAgent }: LibraryScreenProps) {
  const { library, status, isError, refetch } = useProjectLibrary(projectId);
  const [selection, setSelection] = useState<LibrarySelection | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<LibrarySelection | null>(null);
  const [guardSaving, setGuardSaving] = useState(false);
  const saveHandlerRef = useRef<(() => Promise<boolean>) | null>(null);

  const registerSaveHandler = useCallback((handler: (() => Promise<boolean>) | null) => {
    saveHandlerRef.current = handler;
  }, []);

  const applySelection = useCallback((next: LibrarySelection) => {
    setSelection(next);
    setIsDirty(false);
    setPendingSelection(null);
  }, []);

  const requestSelection = useCallback(
    (next: LibrarySelection) => {
      if (isDirty && selection && selectionKey(selection) !== selectionKey(next)) {
        setPendingSelection(next);
        return;
      }
      applySelection(next);
    },
    [applySelection, isDirty, selection],
  );

  if (status === "loading") {
    return <LibraryLoadingState />;
  }

  if (isError || !library) {
    return <LibraryErrorState onRetry={refetch} />;
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <LibraryListColumn library={library} selection={selection} onSelect={requestSelection} />
        <div className="min-h-0 min-w-0 flex-1 bg-background">
          <LibraryDetailPane
            projectId={projectId}
            library={library}
            selection={selection}
            onDirtyChange={setIsDirty}
            registerSaveHandler={registerSaveHandler}
            onClearSelection={() => setSelection(null)}
            onTestAgent={onTestAgent}
          />
        </div>
      </div>
      <UnsavedChangesDialog
        open={pendingSelection !== null}
        saving={guardSaving}
        onCancel={() => setPendingSelection(null)}
        onDiscard={() => {
          if (pendingSelection) applySelection(pendingSelection);
        }}
        onSaveAndSwitch={() => {
          if (!pendingSelection) return;
          const next = pendingSelection;
          void (async () => {
            setGuardSaving(true);
            const saved = (await saveHandlerRef.current?.()) ?? true;
            setGuardSaving(false);
            if (saved) applySelection(next);
          })();
        }}
      />
    </>
  );
}

function LibraryLoadingState() {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-72 shrink-0 flex-col gap-4 border-r border-border-subtle p-3">
        {(["agents", "skills", "packages"] as const).map((section) => (
          <div key={section} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ))}
      </div>
      <div className="flex flex-1 items-center justify-center">
        <Skeleton className="h-4 w-40" />
      </div>
    </div>
  );
}

function LibraryErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">
        <Trans>Could not load the library for this project.</Trans>
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="focus-ring rounded-md border border-border-subtle bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle"
      >
        <Trans>Try again</Trans>
      </button>
    </div>
  );
}

type LibraryListColumnProps = {
  library: ProjectLibraryResponse;
  selection: LibrarySelection | null;
  onSelect: (selection: LibrarySelection) => void;
};

function LibraryListColumn({ library, selection, onSelect }: LibraryListColumnProps) {
  const agentGroups = useMemo(() => groupBySource(library.agents), [library.agents]);
  const skillGroups = useMemo(() => groupBySource(library.skills), [library.skills]);
  const showEmptyPackagesHint = library.packages.length === 0;

  return (
    <div className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-border-subtle bg-background">
      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border-subtle px-3 py-2">
        {/* TODO(editor): wire to agent creation flow */}
        <StubAction label={t`New agent`} disabled />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-2 py-3">
        <InventorySection title={<Trans>Agents</Trans>}>
          {agentGroups.length === 0 ? (
            <EmptySectionNote>
              <Trans>No agents yet.</Trans>
            </EmptySectionNote>
          ) : (
            agentGroups.map((group) => (
              <SourceGroup key={group.label} label={group.label}>
                {group.items.map((agent) => (
                  <AgentRow
                    key={agent.slug}
                    agent={agent}
                    selected={selection?.kind === "agent" && selection.slug === agent.slug}
                    onSelect={() => onSelect({ kind: "agent", slug: agent.slug })}
                  />
                ))}
              </SourceGroup>
            ))
          )}
        </InventorySection>

        <InventorySection title={<Trans>Skills</Trans>}>
          {skillGroups.length === 0 ? (
            <EmptySectionNote>
              <Trans>No skills yet.</Trans>
            </EmptySectionNote>
          ) : (
            skillGroups.map((group) => (
              <SourceGroup key={group.label} label={group.label}>
                {group.items.map((skill) => (
                  <SkillRow
                    key={skill.slug}
                    skill={skill}
                    selected={selection?.kind === "skill" && selection.slug === skill.slug}
                    onSelect={() => onSelect({ kind: "skill", slug: skill.slug })}
                  />
                ))}
              </SourceGroup>
            ))
          )}
        </InventorySection>

        <InventorySection
          title={<Trans>Packages</Trans>}
          footer={
            showEmptyPackagesHint ? (
              <p className="px-2 py-1 text-meta text-muted-foreground">
                <Trans>Install a package to add agents and skills.</Trans>
              </p>
            ) : undefined
          }
        >
          {library.packages.length === 0 ? (
            <EmptySectionNote>
              <Trans>No packages installed.</Trans>
            </EmptySectionNote>
          ) : (
            library.packages.map((pkg) => (
              <PackageRow
                key={pkg.slug}
                pkg={pkg}
                selected={selection?.kind === "package" && selection.slug === pkg.slug}
                onSelect={() => onSelect({ kind: "package", slug: pkg.slug })}
              />
            ))
          )}
          <div className="px-1 pt-2">
            <AddPackageAction
              selected={selection?.kind === "install"}
              onSelect={() => onSelect({ kind: "install" })}
            />
          </div>
        </InventorySection>
      </div>
    </div>
  );
}

function InventorySection({
  title,
  children,
  footer,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="mb-5 flex flex-col gap-2">
      <SectionLabel>{title}</SectionLabel>
      <div className="flex flex-col gap-1">{children}</div>
      {footer}
    </section>
  );
}

function SourceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 py-0.5 text-meta text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function EmptySectionNote({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-meta text-muted-foreground">{children}</p>;
}

function EditedBadge() {
  return (
    <span className="status-pill shrink-0 border border-border-subtle bg-surface-subtle text-ink-subtle">
      <Trans>Edited</Trans>
    </span>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: LibraryAgentSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={selectionKey({ kind: "agent", slug: agent.slug })}
      className={cn(
        "focus-ring w-full rounded-lg text-left transition-colors",
        selected && "ring-1 ring-border-focus",
        !agent.enabled && "opacity-50",
      )}
    >
      <div className="flex items-start gap-2 p-0.5">
        <AgentChip
          variant="card"
          agent={{
            slug: agent.slug,
            name: agent.name,
            description: agent.description,
            source: agent.source,
            packageName: agent.packageName,
          }}
          className="pointer-events-none min-w-0 flex-1"
        />
        {agent.isEdited ? <EditedBadge /> : null}
      </div>
    </button>
  );
}

function SkillRow({
  skill,
  selected,
  onSelect,
}: {
  skill: LibrarySkillSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "focus-ring flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-subtle",
        selected && "bg-surface-subtle ring-1 ring-border-focus",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <code className="truncate font-mono text-meta font-medium text-foreground">
          {skill.slug}
        </code>
        {skill.isEdited ? <EditedBadge /> : null}
      </span>
      {skill.description ? (
        <span className="line-clamp-2 text-meta text-muted-foreground">{skill.description}</span>
      ) : null}
    </button>
  );
}

function PackageRow({
  pkg,
  selected,
  onSelect,
}: {
  pkg: LibraryPackageSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const counts = t`${pkg.agentCount} agents, ${pkg.skillCount} skills`;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "focus-ring flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-subtle",
        selected && "bg-surface-subtle ring-1 ring-border-focus",
      )}
    >
      <span className="truncate text-sm font-medium text-foreground">{pkg.name}</span>
      <span className="text-meta text-muted-foreground">
        {pkg.version ? t`v${pkg.version} · ${counts}` : counts}
      </span>
    </button>
  );
}

function StubAction({ label, disabled }: { label: string; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 text-meta font-medium text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Plus className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}

function AddPackageAction({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "focus-ring inline-flex w-full items-center gap-1 rounded-md px-2 py-1 text-meta font-medium text-muted-foreground hover:bg-surface-subtle hover:text-foreground",
        selected && "bg-surface-subtle ring-1 ring-border-focus text-foreground",
      )}
    >
      <Plus className="size-3.5" aria-hidden />
      <Trans>Add package</Trans>
    </button>
  );
}
