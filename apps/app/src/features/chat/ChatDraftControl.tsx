/**
 * Which of its Work's drafts a chat writes into, in the composer's toolbar: offered in Draft mode
 * while the Work has several. Picking one points the chat's lineage there
 * (`PUT /api/threads/:id/draft`); its next writes go into that draft, and its dock lists it.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AiWriteMode, Work } from "@meridian/contracts/works";
import { useRef } from "react";
import { useSetChatDraft, useWorkDrafts } from "@/client/query/draft-commands";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import {
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import { Button } from "@/components/ui/button";
import { dropdownRowVariants } from "@/components/ui/dropdown-presentation";
import { handleListKeys } from "@/components/ui/list-keys";
import { LabelNote } from "@/components/ui/marks";
import { workDraftName } from "@/features/draft-review/draft-names";

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
  const drafts = useWorkDrafts(projectId, work.isNoWork ? null : work.id).drafts;
  const setChatDraft = useSetChatDraft(projectId);
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
        <div
          role="radiogroup"
          aria-label={t`Draft this chat writes into`}
          className="space-y-[var(--chat-space-inline)]"
          onKeyDown={handleListKeys}
        >
          {drafts.map((draft, index) => {
            const files = draft.pendingDocumentCount + draft.pendingFolderCount;
            const selected = draft.id === current.id;
            return (
              <Button
                key={draft.id}
                data-list-item
                ref={selected ? selectedRef : index === 0 ? firstRef : undefined}
                role="radio"
                aria-checked={selected}
                variant="ghost"
                className={dropdownRowVariants({ selected })}
                onClick={() => {
                  if (!selected) setChatDraft(thread, draft.id);
                  terminalClose();
                }}
              >
                <span className="min-w-0 flex-1 truncate text-left">{workDraftName(draft)}</span>
                {files > 0 ? (
                  <LabelNote className="shrink-0">
                    {plural(files, { one: "# file", other: "# files" })}
                  </LabelNote>
                ) : null}
              </Button>
            );
          })}
        </div>
      ),
    },
  };
}
