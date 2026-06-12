// @ts-nocheck
/**
 * PackageInstallFlow — in-pane install gallery, URL preview, and apply (design 2D / 2E).
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type {
  PackageInstallApplyResponse,
  PackageInstallPreviewResponse,
  PackageInstallSource,
} from "@meridian/contracts/agents";
import { useState } from "react";

import { isMeridianApiError } from "@/client/api/http-client";
import {
  type InstallSourceState,
  useApplyPackageInstall,
  usePackagesCatalog,
  usePreviewPackageInstall,
} from "@/client/query/usePackageInstall";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

import {
  catalogSourceFromId,
  collisionLabel,
  githubSourceFromUrl,
  previewWillInstallAgents,
  previewWillInstallSkills,
} from "./package-install-helpers";

type InstallStep =
  | { step: "browse" }
  | { step: "preview"; source: PackageInstallSource; preview: PackageInstallPreviewResponse }
  | { step: "success"; result: PackageInstallApplyResponse; packageName: string }
  | { step: "error"; message: string; retry: () => void };

export type PackageInstallFlowProps = {
  workbenchId: string;
  onCancel: () => void;
};

export function PackageInstallFlow({ workbenchId, onCancel }: PackageInstallFlowProps) {
  const catalogQuery = usePackagesCatalog();
  const previewMutation = usePreviewPackageInstall(workbenchId);
  const applyMutation = useApplyPackageInstall(workbenchId);
  const [urlInput, setUrlInput] = useState("");
  const [flow, setFlow] = useState<InstallStep>({ step: "browse" });

  async function runPreview(sourceState: InstallSourceState) {
    try {
      const preview = await previewMutation.mutateAsync({ source: sourceState.source });
      setFlow({ step: "preview", source: sourceState.source, preview });
    } catch (error) {
      setFlow({
        step: "error",
        message: errorMessage(error),
        retry: () => setFlow({ step: "browse" }),
      });
    }
  }

  async function runApply(
    source: PackageInstallSource,
    packageName: string,
    preview: PackageInstallPreviewResponse,
  ) {
    try {
      const result = await applyMutation.mutateAsync({ source });
      setFlow({ step: "success", result, packageName });
    } catch (error) {
      setFlow({
        step: "error",
        message: errorMessage(error),
        retry: () => setFlow({ step: "preview", source, preview }),
      });
    }
  }

  if (flow.step === "success") {
    return (
      <InstallSuccessSummary
        packageName={flow.packageName}
        result={flow.result}
        onDone={onCancel}
      />
    );
  }

  if (flow.step === "error") {
    return <FlowError message={flow.message} onRetry={flow.retry} onCancel={onCancel} />;
  }

  if (flow.step === "preview") {
    return (
      <InstallPreviewPanel
        preview={flow.preview}
        applying={applyMutation.isPending}
        onCancel={() => setFlow({ step: "browse" })}
        onInstall={() => void runApply(flow.source, flow.preview.packageName, flow.preview)}
      />
    );
  }

  const catalogLoading = catalogQuery.isPending;
  const catalogError = catalogQuery.isError;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-5">
      <div className="flex max-w-xl flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">
            <Trans>Add a package</Trans>
          </h2>
        </header>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            <Trans>Featured</Trans>
          </h3>
          {catalogLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : null}
          {catalogError ? (
            <FlowError
              message={t`Could not load the package gallery.`}
              onRetry={() => void catalogQuery.refetch()}
              onCancel={onCancel}
            />
          ) : null}
          {catalogQuery.data?.packages.map((entry) => {
            const installable = Boolean(entry.sourceUrl);
            return (
              <div
                key={entry.id}
                className="flex items-start justify-between gap-3 border-b border-border-subtle py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{entry.name}</p>
                  <p className="text-meta text-muted-foreground">{entry.description}</p>
                  {!installable ? (
                    <p className="mt-1 text-meta text-muted-foreground">
                      <Trans>Coming soon</Trans>
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={!installable || previewMutation.isPending}
                  onClick={() =>
                    void runPreview({
                      source: catalogSourceFromId(entry.id),
                      label: entry.name,
                    })
                  }
                  className="focus-ring shrink-0 rounded-md border border-border-subtle bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trans>Install</Trans>
                </button>
              </div>
            );
          })}
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            <Trans>Or paste a package URL</Trans>
          </h3>
          <div className="flex gap-2">
            <Input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              placeholder={t`github.com/lab/my-package`}
              className="min-w-0 flex-1"
            />
            <button
              type="button"
              disabled={!urlInput.trim() || previewMutation.isPending}
              onClick={() =>
                void runPreview({
                  source: githubSourceFromUrl(urlInput),
                  label: urlInput.trim(),
                })
              }
              className="focus-ring shrink-0 rounded-md border border-border-subtle bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-50"
            >
              {previewMutation.isPending ? <Trans>Previewing…</Trans> : <Trans>Preview</Trans>}
            </button>
          </div>
        </section>

        <div>
          <button
            type="button"
            onClick={onCancel}
            className="focus-ring rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-surface-subtle hover:text-foreground"
          >
            <Trans>Cancel</Trans>
          </button>
        </div>
      </div>
    </div>
  );
}

function InstallPreviewPanel({
  preview,
  applying,
  onCancel,
  onInstall,
}: {
  preview: PackageInstallPreviewResponse;
  applying: boolean;
  onCancel: () => void;
  onInstall: () => void;
}) {
  const agentNames = previewWillInstallAgents(preview);
  const skillNames = previewWillInstallSkills(preview);
  const versionLabel = preview.version ? `v${preview.version}` : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-5">
      <div className="flex max-w-xl flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">
            <Trans>Install preview</Trans>
          </h2>
          <p className="text-sm font-medium text-foreground">
            {preview.packageName}
            {versionLabel ? ` ${versionLabel}` : null}
          </p>
          {preview.description ? (
            <p className="text-sm text-muted-foreground">{preview.description}</p>
          ) : null}
        </header>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            <Trans>Will install:</Trans>
          </h3>
          {agentNames.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Agents:</Trans> {agentNames.join(", ")}
            </p>
          ) : null}
          {skillNames.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Skills:</Trans> {skillNames.join(", ")}
            </p>
          ) : null}
          {agentNames.length === 0 && skillNames.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                No new agents or skills — dependencies only, or everything already exists.
              </Trans>
            </p>
          ) : null}
        </section>

        {preview.collisions.length > 0 ? (
          <section className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/30">
            {preview.collisions.map((collision) => (
              <p
                key={`${collision.kind}:${collision.slug}`}
                className="text-sm text-amber-950 dark:text-amber-100"
              >
                {t`Collision: ${collisionLabel(collision)} already exists — will keep your existing version (skipped)`}
              </p>
            ))}
          </section>
        ) : null}

        {preview.includesSetupInstructions ? (
          <p className="text-sm text-muted-foreground">
            <Trans>
              Includes setup instructions — the agent will configure its environment on first use.
            </Trans>
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={applying}
            className="focus-ring rounded-md border border-border-subtle px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle disabled:opacity-50"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            onClick={onInstall}
            disabled={applying}
            className="focus-ring rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {applying ? <Trans>Installing…</Trans> : <Trans>Install package</Trans>}
          </button>
        </div>
      </div>
    </div>
  );
}

function InstallSuccessSummary({
  packageName,
  result,
  onDone,
}: {
  packageName: string;
  result: PackageInstallApplyResponse;
  onDone: () => void;
}) {
  const installedCount =
    result.insertedAgents.length + result.insertedSkills.length + result.installedPackages.length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-5">
      <div className="flex max-w-xl flex-col gap-4">
        <h2 className="text-base font-semibold text-foreground">
          <Trans>Package installed</Trans>
        </h2>
        <p className="text-sm text-muted-foreground">
          <Trans>{packageName} is ready in your library.</Trans>
        </p>
        {installedCount > 0 ? (
          <ul className="list-inside list-disc text-sm text-muted-foreground">
            {result.insertedAgents.map((slug) => (
              <li key={`agent:${slug}`}>
                <Trans>Added agent {slug}</Trans>
              </li>
            ))}
            {result.insertedSkills.map((slug) => (
              <li key={`skill:${slug}`}>
                <Trans>Added skill {slug}</Trans>
              </li>
            ))}
          </ul>
        ) : null}
        <button
          type="button"
          onClick={onDone}
          className="focus-ring self-start rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Trans>Back to library</Trans>
        </button>
      </div>
    </div>
  );
}

function FlowError({
  message,
  onRetry,
  onCancel,
}: {
  message: string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="focus-ring rounded-md border border-border-subtle bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle"
        >
          <Trans>Try again</Trans>
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-surface-subtle"
        >
          <Trans>Cancel</Trans>
        </button>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (isMeridianApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}
