import React, { useState, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  Turn,
  ContentBlock,
  ThreadRequestOptions,
} from "@/features/threads/types";
import { Card } from "@/shared/components/ui/card";
import { TurnActionBar } from "./TurnActionBar";
import { EditTurnInput } from "./EditTurnInput";
import { useThreadStore } from "@/core/stores/useThreadStore";
import { useCurrentThreadStream } from "@/core/stores/useStreamStore";
import { makeLogger } from "@/core/lib/logger";
import { usePillNavigation } from "@/shared/reference-pill";
import { turnToContentBlocks } from "@/features/threads/utils/turnHelpers";
import { ComposerViewer } from "@/features/threads/composer";
import { userTurnCardBase } from "./styles";

const log = makeLogger("UserTurn");

interface UserTurnProps {
  turn: Turn;
}

/**
 * User turn bubble.
 *
 * Renders user-authored turns as a right-aligned bubble using ComposerViewer
 * (read-only CM6) so display matches the composer's inline reference pills.
 *
 * Performance: Memoized to prevent unnecessary re-renders when turn data unchanged.
 */
export const UserTurn = React.memo(function UserTurn({ turn }: UserTurnProps) {
  const [isEditing, setIsEditing] = useState(false);
  const { streamingTurnId } = useCurrentThreadStream();

  const { switchSibling, editTurn, isLoadingTurns, isSwitchingSibling } =
    useThreadStore(
      useShallow((s) => ({
        switchSibling: s.switchSibling,
        editTurn: s.editTurn,
        isLoadingTurns: s.isLoadingTurns,
        isSwitchingSibling: s.isSwitchingSibling,
      })),
    );

  const isStreaming = streamingTurnId !== null;

  log.debug("render", {
    id: turn.id,
    prevTurnId: turn.prevTurnId,
    blocks: turn.blocks.length,
  });

  const handleNavigate = useCallback(
    (turnId: string) => {
      switchSibling(turn.threadId, turnId);
    },
    [switchSibling, turn.threadId],
  );

  const handleSaveEdit = useCallback(
    async (blocks: ContentBlock[], options: ThreadRequestOptions) => {
      await editTurn(turn.threadId, turn.id, blocks, options);
      setIsEditing(false);
    },
    [editTurn, turn.threadId, turn.id],
  );

  // Pill click -> open documents in editor, folders in a popover
  const { handlePillClick, folderPopover } = usePillNavigation();

  const handleEdit = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleCloseEdit = useCallback(() => {
    setIsEditing(false);
  }, []);

  // Memoize content blocks to avoid re-computing on every render
  const contentBlocks = useMemo(() => turnToContentBlocks(turn), [turn]);

  // Compute draft info from sibling IDs for edit placeholder
  // Server may or may not include the current turn ID in siblingIds
  const { draftNumber, totalDrafts } = useMemo(() => {
    const siblingIdsRaw = turn.siblingIds || [];
    const siblingList = siblingIdsRaw.includes(turn.id)
      ? siblingIdsRaw
      : [turn.id, ...siblingIdsRaw];
    // Editing creates a new sibling draft, so +1 for the upcoming draft
    return {
      draftNumber: siblingList.length + 1,
      totalDrafts: siblingList.length + 1,
    };
  }, [turn.id, turn.siblingIds]);

  return (
    <div
      className="group flex min-w-0 flex-col items-end gap-1 text-sm"
      data-turn-id={turn.id}
    >
      {isEditing ? (
        <EditTurnInput
          isOpen={isEditing}
          onClose={handleCloseEdit}
          initialBlocks={contentBlocks}
          originalRequestParams={turn.requestParams}
          onSave={handleSaveEdit}
          draftNumber={draftNumber}
          totalDrafts={totalDrafts}
        />
      ) : (
        <>
          {/* Card styling synced with EditTurnInput via userTurnCardBase */}
          <Card className={userTurnCardBase}>
            <ComposerViewer
              blocks={contentBlocks}
              onPillClick={handlePillClick}
            />
          </Card>

          <TurnActionBar
            turn={turn}
            isLoading={isLoadingTurns || isSwitchingSibling || isStreaming}
            onNavigate={handleNavigate}
            onEdit={handleEdit}
            className="mr-1"
          />
        </>
      )}
      {folderPopover}
    </div>
  );
});
