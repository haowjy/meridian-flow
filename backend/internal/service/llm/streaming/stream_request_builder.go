package streaming

import (
	"context"
	"fmt"
	"log/slog"

	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/formatting"
	threadhistory "meridian/internal/service/llm/thread_history"
)

// StreamRequestBuilder loads conversation history and transforms @-references
// into provider-ready messages. Used by both production streaming and debug endpoints.
type StreamRequestBuilder struct {
	turnNavigator     domainllm.TurnNavigator
	turnReader        domainllm.TurnReader
	messageBuilder    domainllm.MessageBuilder
	documentSvc       domaindocsys.DocumentService
	folderSvc         domaindocsys.FolderService
	formatterRegistry *formatting.FormatterRegistry
	logger            *slog.Logger
}

type StreamRequestBuilderDeps struct {
	TurnNavigator     domainllm.TurnNavigator
	TurnReader        domainllm.TurnReader
	MessageBuilder    domainllm.MessageBuilder
	DocumentSvc       domaindocsys.DocumentService
	FolderSvc         domaindocsys.FolderService
	FormatterRegistry *formatting.FormatterRegistry
	Logger            *slog.Logger
}

func NewStreamRequestBuilder(deps StreamRequestBuilderDeps) *StreamRequestBuilder {
	return &StreamRequestBuilder{
		turnNavigator:     deps.TurnNavigator,
		turnReader:        deps.TurnReader,
		messageBuilder:    deps.MessageBuilder,
		documentSvc:       deps.DocumentSvc,
		folderSvc:         deps.FolderSvc,
		formatterRegistry: deps.FormatterRegistry,
		logger:            deps.Logger,
	}
}

// BuildConversationMessages loads turn path, builds messages, then transforms references.
// Convenience wrapper for the common production path.
func (b *StreamRequestBuilder) BuildConversationMessages(
	ctx context.Context,
	turnID string,
	userID string,
	projectID string,
) ([]domainllm.Message, error) {
	messages, err := b.LoadConversationHistory(ctx, turnID)
	if err != nil {
		return nil, err
	}
	return b.TransformMessageReferences(ctx, messages, userID, projectID)
}

// LoadConversationHistory loads the turn path and builds LLM messages from it.
// Returns untransformed messages — @-references are NOT yet expanded.
func (b *StreamRequestBuilder) LoadConversationHistory(ctx context.Context, turnID string) ([]domainllm.Message, error) {
	path := []domainllm.Turn{}
	if turnID != "" {
		var err error
		path, err = b.turnNavigator.GetTurnPath(ctx, turnID)
		if err != nil {
			return nil, fmt.Errorf("failed to get turn path: %w", err)
		}

		for i := range path {
			blocks, blocksErr := b.turnReader.GetTurnBlocks(ctx, path[i].ID)
			if blocksErr != nil {
				return nil, fmt.Errorf("failed to get content blocks for turn %s: %w", path[i].ID, blocksErr)
			}
			path[i].Blocks = blocks
		}
	}

	messages, err := b.messageBuilder.BuildMessages(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("failed to build messages: %w", err)
	}
	return messages, nil
}

// TransformMessageReferences compiles @-references in messages into synthetic
// tool_use/tool_result pairs for the provider.
func (b *StreamRequestBuilder) TransformMessageReferences(ctx context.Context, messages []domainllm.Message, userID, projectID string) ([]domainllm.Message, error) {
	refTransformer := threadhistory.NewReferenceMessageTransformer(
		b.documentSvc, b.folderSvc, b.formatterRegistry, userID, projectID, b.logger,
	)
	messages, err := refTransformer.TransformMessages(ctx, messages)
	if err != nil {
		return nil, fmt.Errorf("failed to transform references: %w", err)
	}
	return messages, nil
}
