/**
 * PackageUpdateFlow — in-pane update reconciliation with per-item Restore original (design 2F).
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type {
  LibraryPackageSummary,
  PackageUpdateApplyResponse,
  PackageUpdateCheckResponse,
  ProjectLibraryResponse,
} from "@meridian/contracts/agents";
import { useMemo, useState } from "react";

import { isMeridianApiError } from "@/client/api/http-client";
import { projectPackageExportPath } from "@/client/api/package-install-api";
import { useRestoreAgentDefinitionOriginal } from "@/client/query/useAgentDefinition";
import { useApplyPackageUpdate, usePackageUpdateCheck } from "@/client/query/usePackageInstall";
import { useRestoreSkillDefinitionOriginal } from "@/client/query/useSkillDefinition";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { RestoreOriginalButton } from "../editor/RestoreOriginalButton";
import { updateItemDisplayName } from "./package-install-helpers";

type UpdateStep =
  | { step: "check" }
  | { step: "reconcile"; check: PackageUpdateCheckResponse }
  | { step: "success"; result: PackageUpdateApplyResponse }
  | { step: "error"; message: string };

export type PackageDetailPanelProps = {
  projectId: string;
  pkg: LibraryPackageSummary;
  library: ProjectLibraryResponse;
  className?: string;
  onCloseUpdate?: () => void;
};

export function PackageDetailPanel({
  projectId,
  pkg,
  library,
  className,
  onCloseUpdate,
}: PackageDetailPanelProps) {
  const [showUpdate, setShowUpdate] = useState(false);
  const counts = t`${pkg.agentCount} agents, ${pkg.skillCount} skills`;

  function handleExport() {
    window.location.assign(projectPackageExportPath(projectId, pkg.installId));
  }

  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-5", className)}>
      <div className="flex max-w-xl flex-col gap-4">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="text-base font-semibold text-foreground">{pkg.name}</h2>
              <p className="text-meta text-muted-foreground">
                {pkg.version ? t`Version ${pkg.version}` : t`Installed package`}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setShowUpdate(true)}
                className="focus-ring rounded-md border border-border-subtle px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle"
              >
                <Trans>Updates</Trans>
              </button>
              <button
                type="button"
                onClick={handleExport}
                className="focus-ring rounded-md border border-border-subtle px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle"
              >
                <Trans>Export</Trans>
              </button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{counts}</p>
        </header>

        {showUpdate ? (
          <PackageUpdateFlow
            projectId={projectId}
            installId={pkg.installId}
            library={library}
            onCancel={() => {
              setShowUpdate(false);
              onCloseUpdate?.();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export function PackageUpdateFlow({
  projectId,
  installId,
  library,
  onCancel,
}: {
  projectId: string;
  installId: string;
  library: ProjectLibraryResponse;
  onCancel: () => void;
}) {
  const checkQuery = usePackageUpdateCheck(projectId, installId, true);
  const applyMutation = useApplyPackageUpdate(projectId, installId);
  const [localStep, setLocalStep] = useState<UpdateStep | null>(null);

  const nameBySlug = useMemo(() => buildNameBySlug(library), [library]);

  if (localStep?.step === "success") {
    return <UpdateSuccessSummary result={localStep.result} onDone={onCancel} />;
  }

  if (localStep?.step === "error") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border-subtle px-3 py-2">
        <p className="text-sm text-muted-foreground">{localStep.message}</p>
        <button
          type="button"
          onClick={() => setLocalStep(null)}
          className="focus-ring self-start text-sm text-foreground underline-offset-2 hover:underline"
        >
          <Trans>Try again</Trans>
        </button>
      </div>
    );
  }

  if (checkQuery.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (checkQuery.isError) {
    const message = isMeridianApiError(checkQuery.error)
      ? checkQuery.error.message
      : t`Could not check for updates. The install source may no longer be available.`;
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border-subtle px-3 py-2">
        <p className="text-sm text-muted-foreground">{message}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void checkQuery.refetch()}
            className="focus-ring rounded-md border border-border-subtle px-2 py-1 text-sm hover:bg-surface-subtle"
          >
            <Trans>Try again</Trans>
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="focus-ring px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <Trans>Cancel</Trans>
          </button>
        </div>
      </div>
    );
  }

  const check = checkQuery.data;
  if (!check) return null;

  if (!check.updateAvailable) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border-subtle px-3 py-2">
        <p className="text-sm text-muted-foreground">
          <Trans>You have the latest version.</Trans>
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring self-start text-sm text-muted-foreground hover:text-foreground"
        >
          <Trans>Close</Trans>
        </button>
      </div>
    );
  }

  const upstreamLabel = check.upstreamVersion ? `v${check.upstreamVersion}` : t`latest`;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border-subtle px-3 py-3">
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-foreground">
          <Trans>Update available</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          {check.packageName} → {upstreamLabel}
        </p>
      </header>

      {check.willUpdate.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h4 className="text-meta font-semibold text-foreground">
            <Trans>Will update:</Trans>
          </h4>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {check.willUpdate.map((item) => (
              <li key={`${item.kind}:${item.slug}`}>
                ✓ {updateItemDisplayName(item, nameBySlug)}{" "}
                <span className="text-meta">
                  <Trans>(you have not modified)</Trans>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {check.willKeep.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h4 className="text-meta font-semibold text-foreground">
            <Trans>Kept as-is — you have customized these:</Trans>
          </h4>
          <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
            {check.willKeep.map((item) => (
              <li key={`${item.kind}:${item.slug}`} className="flex flex-wrap items-center gap-2">
                <span>
                  ○ {updateItemDisplayName(item, nameBySlug)} —{" "}
                  <Trans>your version preserved</Trans>
                </span>
                <UpdateItemRestoreOriginal
                  projectId={projectId}
                  kind={item.kind}
                  slug={item.slug}
                  onRestored={() => void checkQuery.refetch()}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={applyMutation.isPending}
          className="focus-ring rounded-md border border-border-subtle px-3 py-1.5 text-sm font-medium hover:bg-surface-subtle disabled:opacity-50"
        >
          <Trans>Cancel</Trans>
        </button>
        <button
          type="button"
          disabled={applyMutation.isPending}
          onClick={() => {
            void applyMutation.mutateAsync().then(
              (result) => setLocalStep({ step: "success", result }),
              (error) =>
                setLocalStep({
                  step: "error",
                  message: isMeridianApiError(error) ? error.message : t`Update failed.`,
                }),
            );
          }}
          className="focus-ring rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {applyMutation.isPending ? <Trans>Applying…</Trans> : <Trans>Apply update</Trans>}
        </button>
      </div>
    </div>
  );
}

function UpdateItemRestoreOriginal({
  projectId,
  kind,
  slug,
  onRestored,
}: {
  projectId: string;
  kind: "agent" | "skill";
  slug: string;
  onRestored: () => void;
}) {
  const restoreAgent = useRestoreAgentDefinitionOriginal(projectId, slug);
  const restoreSkill = useRestoreSkillDefinitionOriginal(projectId, slug);
  const pending = kind === "agent" ? restoreAgent.isPending : restoreSkill.isPending;

  return (
    <RestoreOriginalButton
      pending={pending}
      onConfirm={async () => {
        if (kind === "agent") {
          await restoreAgent.mutateAsync();
        } else {
          await restoreSkill.mutateAsync();
        }
        onRestored();
      }}
    />
  );
}

function UpdateSuccessSummary({
  result,
  onDone,
}: {
  result: PackageUpdateApplyResponse;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border-subtle px-3 py-3">
      <h3 className="text-sm font-semibold text-foreground">
        <Trans>Update applied</Trans>
      </h3>
      <ul className="list-inside list-disc text-sm text-muted-foreground">
        {result.updatedAgents.map((slug) => (
          <li key={`u-a:${slug}`}>
            <Trans>Updated agent {slug}</Trans>
          </li>
        ))}
        {result.updatedSkills.map((slug) => (
          <li key={`u-s:${slug}`}>
            <Trans>Updated skill {slug}</Trans>
          </li>
        ))}
        {result.keptAgents.map((slug) => (
          <li key={`k-a:${slug}`}>
            <Trans>Kept agent {slug} as-is</Trans>
          </li>
        ))}
        {result.keptSkills.map((slug) => (
          <li key={`k-s:${slug}`}>
            <Trans>Kept skill {slug} as-is</Trans>
          </li>
        ))}
        {result.retiredAgents.map((slug) => (
          <li key={`r-a:${slug}`}>
            <Trans>Retired agent {slug}</Trans>
          </li>
        ))}
        {result.retiredSkills.map((slug) => (
          <li key={`r-s:${slug}`}>
            <Trans>Retired skill {slug}</Trans>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onDone}
        className="focus-ring self-start rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
      >
        <Trans>Done</Trans>
      </button>
    </div>
  );
}

function buildNameBySlug(library: ProjectLibraryResponse): Map<string, string> {
  const map = new Map<string, string>();
  for (const agent of library.agents) {
    map.set(agent.slug, agent.name);
  }
  for (const skill of library.skills) {
    map.set(skill.slug, skill.description || skill.slug);
  }
  return map;
}
