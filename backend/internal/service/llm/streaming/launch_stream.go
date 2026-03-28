package streaming

// launch_stream.go — Pipeline stage 4: build production tool registry and delegate
// stream launch to StreamRuntime.

import (
	"context"
	"fmt"

	domainllm "meridian/internal/domain/llm"
)

// launchStream creates the production registry and delegates stream launch to StreamRuntime.
func (p *turnPipeline) launchStream(ctx context.Context) (*domainllm.CreateTurnResponse, error) {
	svc := p.svc
	req := p.req

	var thread *domainllm.Thread
	if p.turnCtx.CreatedThread != nil {
		thread = p.turnCtx.CreatedThread
	} else {
		var threadErr error
		thread, threadErr = svc.threadRepo.GetThread(ctx, p.turnCtx.ThreadCtx.threadID, req.UserID)
		if threadErr != nil {
			svc.logger.Error("failed to get thread for tools",
				"error", threadErr,
				"thread_id", p.turnCtx.ThreadCtx.threadID,
				"user_id", req.UserID,
			)
			if updateErr := svc.turnWriter.UpdateTurnError(ctx, p.assistantTurn.ID, fmt.Sprintf("failed to get thread: %v", threadErr)); updateErr != nil {
				svc.logger.Error("failed to update turn error", "error", updateErr)
			}
			return nil, fmt.Errorf("failed to get thread for tools: %w", threadErr)
		}
	}

	workItemSlug := ""
	if p.turnCtx.ResolvedWorkItem != nil {
		workItemSlug = p.turnCtx.ResolvedWorkItem.Slug
	}

	workItemID := ""
	if p.turnCtx.ResolvedWorkItem != nil {
		workItemID = p.turnCtx.ResolvedWorkItem.ID
	} else if thread.WorkItemID != nil {
		workItemID = *thread.WorkItemID
	}

	toolRegistry := svc.toolRegistryFactory.BuildProductionRegistry(
		ToolRegistryInputs{
			EnabledTools: p.turnCtx.EnabledTools,
			ProjectID:    thread.ProjectID,
			UserID:       req.UserID,
			WorkItemSlug: workItemSlug,
			Persona:      p.turnCtx.ResolvedPersona,
		},
		p.availableSkills,
		thread.ID,
		workItemID,
	)

	streamSwitchFn := svc.streamRuntime.CreateStreamSwitchFn(
		p.turnCtx.ThreadCtx.threadID,
		req.UserID,
		p.turnCtx.RequestParams,
		svc.CreateTurn,
	)

	resp, err := svc.streamRuntime.Launch(ctx, &LaunchInput{
		AssistantTurn:  p.assistantTurn,
		UserTurn:       p.userTurn,
		Thread:         p.turnCtx.CreatedThread,
		ThreadID:       p.turnCtx.ThreadCtx.threadID,
		UserID:         req.UserID,
		ProjectID:      p.turnCtx.ThreadCtx.projectID,
		Model:          p.turnCtx.Model,
		Provider:       p.turnCtx.Provider,
		Params:         p.turnCtx.Params,
		ToolRegistry:   toolRegistry,
		SettlementMode: svc.resolveSettlementMode(p.turnCtx.Provider),
		StreamSwitchFn: streamSwitchFn,
	}, func() {
		svc.turnContextResolver.ReleaseStreamSlot(req.UserID)
	})
	if err != nil {
		return nil, err
	}

	// Launch transferred stream-slot ownership to executor cleanup callback.
	p.turnCtx.StreamAcquired = false
	return resp, nil
}
