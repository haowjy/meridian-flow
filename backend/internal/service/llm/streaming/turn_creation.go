package streaming

// turn_creation.go — Pipeline orchestrator for CreateTurn.
//
// Decomposed into a 4-stage pipeline:
//   gatherContext  -> assemblePrompt -> persistTurns -> launchStream
//
// Each stage is a method on turnPipeline (see gather_context.go, assemble_prompt.go,
// persist_turns.go, launch_stream.go). Validation and utility helpers are in
// turn_helpers.go.

import (
	"context"
	"fmt"
	"strings"

	"meridian/internal/domain"
	billing "meridian/internal/domain/billing"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
)

// defaultFallbackModel is used when config.LLM.DefaultModel is not set.
// This is a last-resort safety net, not an operational default.
const defaultFallbackModel = "moonshotai/kimi-k2-thinking"

// turnPipeline holds per-request state flowing between pipeline stages.
// Each stage reads from and writes to this struct, making stages independently testable.
//
// ctx is intentionally NOT stored here — Go best practice is to pass context as a
// parameter, not store it in a struct. Each stage method receives ctx as its first arg.
type turnPipeline struct {
	// Inputs (set by orchestrator before pipeline runs)
	svc *Service
	req *domainllm.CreateTurnRequest

	// Stage 1: gatherContext outputs
	threadCtx      *threadContext
	project        *domaindocsys.Project
	requestParams  map[string]interface{}
	params         *domainllm.RequestParams
	model          string
	provider       string
	createdThread  *domainllm.Thread // Only set on cold start
	streamAcquired bool              // True if stream slot acquired; cleanup transfers ownership

	// Stage 2: assemblePrompt outputs
	availableSkills []domainagents.RuntimeSkill
	enabledTools    []string // Extracted from requestParams; used by production tool registry

	// Stage 3: persistTurns outputs
	userTurn      *domainllm.Turn
	assistantTurn *domainllm.Turn
}

// threadContext holds resolved thread information for turn creation.
type threadContext struct {
	threadID    string // Resolved thread ID (empty until created on cold start)
	projectID   string // Project ID (always set)
	isNewThread bool   // True if cold start (new thread)
}

// CreateTurn creates a new user turn and triggers assistant streaming response.
// Returns both the user turn and the assistant turn for client to connect to SSE stream.
//
// Thread resolution priority:
// 1. If PrevTurnID provided -> lookup its thread_id from DB (ignores ThreadID/ProjectID)
// 2. Else if ThreadID provided -> use that thread
// 3. Else if ProjectID provided -> create new thread (cold start, title from first text block)
// 4. Else -> validation error
func (s *Service) CreateTurn(ctx context.Context, req *domainllm.CreateTurnRequest) (*domainllm.CreateTurnResponse, error) {
	// Normalize empty strings to nil
	if req.PrevTurnID != nil && *req.PrevTurnID == "" {
		req.PrevTurnID = nil
	}
	if req.ThreadID != nil && *req.ThreadID == "" {
		req.ThreadID = nil
	}
	if req.ProjectID != nil && *req.ProjectID == "" {
		req.ProjectID = nil
	}

	// Validate basic request fields (role, turn blocks)
	if err := s.validateCreateTurnRequest(req); err != nil {
		return nil, domain.NewValidationError(fmt.Sprintf("validation failed: %v", err))
	}

	// Build pipeline with per-request state
	p := &turnPipeline{
		svc: s,
		req: req,
	}

	// Release stream slot on error paths; ownership transfers to cleanup in launchStream.
	defer func() {
		if p.streamAcquired {
			s.userStreamTracker.Release(req.UserID)
		}
	}()

	// Orphan-thread guard: if a cold-start thread was created but turn persistence
	// failed (so no user turn exists yet), delete the orphaned thread to keep the DB clean.
	// Uses context.Background() because the request ctx may already be cancelled on error.
	defer func() {
		if p.createdThread != nil && p.userTurn == nil {
			if _, err := s.threadRepo.DeleteThread(context.Background(), p.createdThread.ID, req.UserID); err != nil {
				s.logger.Warn("failed to delete orphaned cold-start thread",
					"thread_id", p.createdThread.ID,
					"error", err,
				)
			}
		}
	}()

	// Stage 1: Resolve thread (create on cold start), project, model, provider, params.
	if err := p.gatherContext(ctx); err != nil {
		return nil, err
	}

	// Stage 2: Build tool section and resolve system prompt.
	if err := p.assemblePrompt(ctx); err != nil {
		return nil, err
	}

	// Stage 3: Persist user turn + assistant turn in a transaction.
	if err := p.persistTurns(ctx); err != nil {
		return nil, err
	}

	// Stage 4: Build production tool registry, create executor, start streaming.
	return p.launchStream(ctx)
}

// resolveSettlementMode picks the billing settlement mode based on provider.
func (s *Service) resolveSettlementMode(provider string) billing.CreditSettlementMode {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openrouter":
		return billing.CreditSettlementDeferredToEnrichment
	case "anthropic":
		return billing.CreditSettlementInlineAuthoritative
	default:
		if s.settlementMode != "" {
			return s.settlementMode
		}
		return billing.CreditSettlementInlineAuthoritative
	}
}
