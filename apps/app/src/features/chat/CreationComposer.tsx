/** Shared new-chat composer for the project Chat landing. */
import { t } from "@lingui/core/macro";
import { useState } from "react";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import { useSelectionAvailableSkills } from "@/client/query/useAvailableSkills";
import { useWorks, workFromSnapshot } from "@/client/query/useWorks";
import { Composer } from "@/components/app/composer";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";
import { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import { NewThreadComposerToolbar } from "@/features/project/chat-landing/NewThreadComposerToolbar";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { useCreationComposer } from "./useCreationComposer";

export function CreationComposer({
  projectId,
  autoFocus = false,
}: {
  projectId: string;
  autoFocus?: boolean;
}) {
  const creation = useCreationComposer(projectId);
  const works = useWorks(projectId);
  const agents = useAgentCatalog(true, projectId);
  const choices = creation.choices;
  const defaultAgent = agents.agents?.find(
    (agent) => agent.ownership === "system" && agent.slug === DEFAULT_AGENT_SLUG,
  );
  const agent = choices?.agent ?? defaultAgent ?? null;
  const availableSkills = useSelectionAvailableSkills(agent?.selection ?? null, projectId);
  const [modePending, setModePending] = useState(false);
  const initialWork = works.works?.find((work) => work.status === "active") ?? null;
  const workId = choices?.workId === undefined ? (initialWork?.id ?? null) : choices.workId;
  const selected = workFromSnapshot(
    works.noWork ? { works: works.works ?? [], noWork: works.noWork } : null,
    workId,
  );
  const work = selected?.status === "active" || selected?.isNoWork ? selected : null;
  const references = useReferenceBrowserCatalog(projectId, work?.id, t`Reference a file`);
  const openDocument = useOpenProjectDocument(projectId);
  const context = agent ? { workId, agent } : undefined;
  const unavailableWork =
    (works.status === "ready" || works.status === "empty") && workId !== null && !work;
  const catalogAgent = agents.agents?.find(
    (item) => item.selection.catalogEntryId === agent?.selection.catalogEntryId,
  );
  const unavailableAgent =
    (agents.status === "ready" || agents.status === "empty") &&
    (!agent ||
      !catalogAgent ||
      (catalogAgent.selection.definitionRevisionId === agent.selection.definitionRevisionId &&
        catalogAgent.unavailableReasons.length > 0));
  const unavailableChoice = unavailableWork || unavailableAgent;
  const unavailableMessage = !unavailableChoice
    ? null
    : unavailableWork
      ? t`Your selected Work is unavailable. Choose another Work or No Work.`
      : t`Your selected Agent is unavailable. Choose another Agent.`;
  const worksReady = works.status === "ready" || works.status === "empty";
  const agentsReady = agents.status === "ready" || agents.status === "empty";
  const choicesReady = worksReady && agentsReady && !unavailableChoice;
  return (
    <>
      <Composer
        variant="hero"
        autoFocus={autoFocus}
        onSubmit={async (envelope) => ({
          kind:
            choicesReady && context && (await creation.submit(envelope, context))
              ? "accepted"
              : "rejected",
          submissionId: envelope.submissionId,
          acceptedRevision: envelope.acceptedRevision,
        })}
        onDraftChange={creation.updateDraft}
        referenceCatalog={references}
        availableSkills={availableSkills.skills}
        onOpenReference={(reference) => {
          void openDocument({ documentId: reference.documentId, disposition: "current" });
        }}
        uploadPort={uploadIntakePort}
        uploadScope={work ? { kind: "work", projectId, workId: work.id } : undefined}
        submitDisabled={!choicesReady || modePending}
        submitDisabledReason={
          unavailableMessage ??
          (modePending
            ? t`Finishing write mode change`
            : !worksReady
              ? t`Loading Work`
              : !agentsReady
                ? agents.isError
                  ? t`Couldn't load agents.`
                  : t`Loading agents…`
                : undefined)
        }
        toolbarLeft={
          <NewThreadComposerToolbar
            projectId={projectId}
            work={work}
            selectedWorkId={workId}
            works={works.works ?? []}
            worksStatus={works.isError ? "error" : worksReady ? "ready" : "loading"}
            agent={agent}
            disabled={modePending}
            onAgentChange={(next) => creation.updateChoices({ agent: next })}
            onWorkChange={(selected) => creation.updateChoices({ workId: selected?.id ?? null })}
            onRetryWorks={works.refetch}
            onModePendingChange={setModePending}
          />
        }
      />
      {works.isError ? (
        <InlineErrorRow message={t`Work couldn’t load`} onRetry={works.refetch} />
      ) : null}
      {unavailableMessage ? (
        <p role="status" className="text-sm text-muted-foreground">
          {unavailableMessage}
        </p>
      ) : null}
    </>
  );
}
