/**
 * Which of its Work's drafts a chat writes into, in the composer's toolbar: offered in Draft mode
 * while the Work has several. Picking one points the chat's lineage there
 * (`PUT /api/threads/:id/draft`); its next writes go into that draft, and its dock lists it. The
 * panel lists the drafts as a version chip's menu does (`WorkDraftRows`), `+ New draft` included,
 * which makes one and points the chat at it.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AiWriteMode, Work } from "@meridian/contracts/works";
import { useRef } from "react";
import { useSetChatDraft, useWorkDrafts } from "@/client/query/draft-commands";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import {
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import { WorkDraftRows } from "@/features/draft-review/DraftSwitcher";
import { nextDraftName, workDraftName } from "@/features/draft-review/draft-names";
import { workDraftVersions } from "@/features/draft-review/work-draft-menu";

export function useChatDraftToolbarControl({
  projectId,
  threadId,
  work,
  writeMode,
}: {
  projectId: string;
  threadId: string;
  work: Work;
  writeMode: AiWriteMode;
}): ComposerToolbarControl | null {
  const thread = useDisplayedThread(projectId, threadId);
  const workDrafts = useWorkDrafts(projectId, work.isNoWork ? null : work.id);
  const drafts = workDrafts.drafts;
  const setChatDraft = useSetChatDraft(projectId, work.id);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const current = drafts?.find((draft) => draft.id === thread?.draftId);
  if (!thread || !drafts || drafts.length < 2 || !current || writeMode !== "draft") return null;
  const name = workDraftName(current);
  return {
    kind: "panel",
    id: "chat-draft",
    priority: 50,
    interaction: "enabled",
    item: {
      ariaLabel: t`Draft this chat writes into: ${name}`,
      label: <Trans>Writes into</Trans>,
      value: name,
    },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger
        binding={trigger}
        ariaLabel={t`Draft this chat writes into: ${name}`}
      >
        {name}
      </ComposerCurrentValueTrigger>
    ),
    panel: {
      ariaLabel: t`Draft this chat writes into`,
      size: "compact",
      focus: {
        pageId: "drafts",
        repairRevision: [current.id, ...drafts.map((draft) => draft.id)].join(),
        candidates: [
          { key: `selected:${current.id}`, ref: selectedRef },
          { key: `first:${drafts[0]?.id}`, ref: firstRef },
        ],
        fallback: "content",
      },
      render: ({ terminalClose }) => (
        <WorkDraftRows
          as="radio"
          label={t`Draft this chat writes into`}
          drafts={workDraftVersions(
            drafts,
            (draftId) => draftId === current.id,
            (draftId) => {
              if (draftId !== current.id) setChatDraft(thread, draftId);
              terminalClose();
            },
          )}
          rowRef={(draft, index) =>
            draft.current ? selectedRef : index === 0 ? firstRef : undefined
          }
          onNewDraft={() => {
            const id = workDrafts.create(nextDraftName(drafts));
            if (id) setChatDraft(thread, id);
            terminalClose();
          }}
        />
      ),
    },
  };
}
