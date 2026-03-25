package streaming

// persist_turns.go — Pipeline stage 3: create user turn, content blocks, and
// assistant turn atomically in a single transaction.
//
// Thread creation has already happened in gatherContext (cold-start fix),
// so this stage only persists turns.

import (
	"context"
	"fmt"
	"time"

	domainllm "meridian/internal/domain/llm"
)

// persistTurns creates the user turn + blocks and assistant turn in a single transaction.
//
// Depends on gatherContext outputs: threadCtx, requestParams, model, createdThread.
// Outputs populated on p: userTurn, assistantTurn.
func (p *turnPipeline) persistTurns(ctx context.Context) error {
	svc := p.svc
	req := p.req
	now := time.Now().UTC()

	err := svc.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// Create user turn
		// Store request_params on user turn so it's available when editing
		userTurn := &domainllm.Turn{
			ThreadID:      p.threadCtx.threadID,
			PrevTurnID:    req.PrevTurnID,
			Role:          req.Role,
			Status:        domainllm.TurnStatusComplete, // User turn is immediately complete
			RequestParams: p.requestParams,
			CreatedAt:     now,
		}

		if err := svc.turnWriter.CreateTurn(txCtx, userTurn); err != nil {
			return err
		}

		// Create content blocks if provided
		if len(req.TurnBlocks) > 0 {
			blocks := make([]domainllm.TurnBlock, len(req.TurnBlocks))
			for i, blockInput := range req.TurnBlocks {
				blocks[i] = domainllm.TurnBlock{
					TurnID:      userTurn.ID,
					BlockType:   blockInput.BlockType,
					Sequence:    i,
					TextContent: blockInput.TextContent,
					Content:     blockInput.Content, // nil becomes NULL in database
					CreatedAt:   now,
				}
			}

			if err := svc.turnWriter.CreateTurnBlocks(txCtx, blocks); err != nil {
				return err
			}

			// Attach content blocks to turn
			userTurn.Blocks = blocks
		}

		// Create assistant turn with status="streaming"
		assistantTurn := &domainllm.Turn{
			ThreadID:      p.threadCtx.threadID,
			PrevTurnID:    &userTurn.ID, // Assistant turn follows user turn
			Role:          "assistant",
			Status:        domainllm.TurnStatusStreaming,
			Model:         &p.model,
			RequestParams: p.requestParams,
			CreatedAt:     time.Now().UTC(),
		}

		if err := svc.turnWriter.CreateTurn(txCtx, assistantTurn); err != nil {
			return fmt.Errorf("failed to create assistant turn: %w", err)
		}

		// Touch project activity (non-fatal - don't fail turn creation for metadata updates)
		if err := svc.projectRepo.TouchLastActivityAt(txCtx, p.threadCtx.projectID); err != nil {
			svc.logger.Warn("failed to touch project activity",
				"project_id", p.threadCtx.projectID,
				"error", err,
			)
		}

		p.userTurn = userTurn
		p.assistantTurn = assistantTurn
		return nil
	})

	if err != nil {
		return err
	}

	svc.logger.Info("user turn created",
		"id", p.userTurn.ID,
		"thread_id", p.threadCtx.threadID,
		"role", req.Role,
		"prev_turn_id", req.PrevTurnID,
		"turn_blocks", len(req.TurnBlocks),
		"is_cold_start", p.threadCtx.isNewThread,
	)

	svc.logger.Info("assistant turn created with streaming status",
		"user_turn_id", p.userTurn.ID,
		"assistant_turn_id", p.assistantTurn.ID,
		"model", p.model,
		"provider", p.provider,
	)

	return nil
}
