package streaming

import (
	"context"
	"log/slog"
	"sync"

	validation "github.com/go-ozzo/ozzo-validation/v4"
	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	billing "meridian/internal/domain/billing"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
	domainwi "meridian/internal/domain/workitem"
	"meridian/internal/jobs"
	"meridian/internal/service/llm/formatting"
	"meridian/internal/service/llm/tokens"
)

type ExecutorRegistry struct {
	executors sync.Map // map[turnID]*StreamExecutor
}

// NewExecutorRegistry creates a new executor registry.
func NewExecutorRegistry() *ExecutorRegistry {
	return &ExecutorRegistry{}
}

// Register adds an executor to the registry.
func (r *ExecutorRegistry) Register(turnID string, executor *StreamExecutor) {
	r.executors.Store(turnID, executor)
}

// Get retrieves an executor by turn ID.
func (r *ExecutorRegistry) Get(turnID string) *StreamExecutor {
	if v, ok := r.executors.Load(turnID); ok {
		return v.(*StreamExecutor)
	}
	return nil
}

// Remove removes an executor from the registry.
func (r *ExecutorRegistry) Remove(turnID string) {
	r.executors.Delete(turnID)
}

// GetByThread finds the active executor for a given thread ID by scanning the registry.
// Returns nil if no active executor is found for the thread.
//
// Used by the cancellation cascade to find child executors when a parent is interrupted.
// Linear scan is acceptable because the total number of active executors is small
// (bounded by MaxConcurrentStreams config) and this path is infrequent.
func (r *ExecutorRegistry) GetByThread(threadID string) *StreamExecutor {
	var result *StreamExecutor
	r.executors.Range(func(_, v interface{}) bool {
		exec := v.(*StreamExecutor)
		if exec.threadID == threadID {
			result = exec
			return false // stop iteration
		}
		return true
	})
	return result
}

// ThreadValidator is shared validation logic for thread operations
type ThreadValidator interface {
	ValidateThread(ctx context.Context, threadID, userID string) error
}

// LLMProviderGetter provides access to LLM providers by model name
type LLMProviderGetter interface {
	GetProvider(model string) (domainllm.LLMProvider, error)
}

// --- Dependency structs for NewStreamingOrchestrator ---

// PersistenceDeps groups repository dependencies for data access.
type PersistenceDeps struct {
	TurnWriter    domainllm.TurnWriter
	TurnReader    domainllm.TurnReader
	TurnNavigator domainllm.TurnNavigator
	ThreadRepo    domainllm.ThreadStore
	ProjectRepo   domaindocsys.ProjectStore // For validating project access on cold start
	TxManager     domain.TransactionManager
	// WorkItemStore is used by contextResolver for work context variable resolution.
	// Optional: nil disables context resolution (non-persona turns unaffected).
	WorkItemStore domainwi.Store
}

// Validate checks that all persistence dependencies are provided.
// WorkItemStore is optional — nil disables work context resolution.
func (d PersistenceDeps) Validate() error {
	return validation.ValidateStruct(&d,
		validation.Field(&d.TurnWriter, validation.Required),
		validation.Field(&d.TurnReader, validation.Required),
		validation.Field(&d.TurnNavigator, validation.Required),
		validation.Field(&d.ThreadRepo, validation.Required),
		validation.Field(&d.ProjectRepo, validation.Required),
		validation.Field(&d.TxManager, validation.Required),
		// WorkItemStore intentionally NOT required — nil disables feature
	)
}

// ServiceDeps groups domain service dependencies used during streaming.
type ServiceDeps struct {
	DocumentSvc          domaindocsys.DocumentService  // For tool operations (SOLID: DIP)
	FolderSvc            domaindocsys.FolderService    // For tool operations (SOLID: DIP)
	TurnContextResolver  *TurnContextResolver          // Resolves stage-1 context (thread/persona/model/params)
	ToolRegistryFactory  *ToolRegistryFactory          // Builds prompt/execution tool registries
	StreamRequestBuilder *StreamRequestBuilder         // Builds conversation messages for LLM
	StreamRuntime        *StreamRuntime                // Owns stream/executor launch lifecycle
	InterjectionRegistry *mstream.InterjectionRegistry // Shared between Service and StreamRuntime
	Validator            ThreadValidator
	Authorizer           authdomain.ResourceAuthorizer
}

// Validate checks that all service dependencies are provided.
func (d ServiceDeps) Validate() error {
	return validation.ValidateStruct(&d,
		validation.Field(&d.DocumentSvc, validation.Required),
		validation.Field(&d.FolderSvc, validation.Required),
		validation.Field(&d.TurnContextResolver, validation.Required),
		validation.Field(&d.ToolRegistryFactory, validation.Required),
		validation.Field(&d.StreamRequestBuilder, validation.Required),
		validation.Field(&d.StreamRuntime, validation.Required),
		validation.Field(&d.InterjectionRegistry, validation.Required),
		validation.Field(&d.Validator, validation.Required),
		validation.Field(&d.Authorizer, validation.Required),
	)
}

// PipelineDeps groups LLM pipeline dependencies (provider routing, prompt building, message formatting).
type PipelineDeps struct {
	ProviderGetter       LLMProviderGetter
	Registry             *mstream.Registry
	SystemPromptResolver domainllm.SystemPromptResolver
	MessageBuilder       domainllm.MessageBuilder
	CapabilityRegistry   *capabilities.Registry        // For checking model capabilities (e.g., supports_tools)
	FormatterRegistry    *formatting.FormatterRegistry // For formatting synthetic tool results (ref transformer)
}

// Validate checks that all pipeline dependencies are provided.
func (d PipelineDeps) Validate() error {
	return validation.ValidateStruct(&d,
		validation.Field(&d.ProviderGetter, validation.Required),
		validation.Field(&d.Registry, validation.Required),
		validation.Field(&d.SystemPromptResolver, validation.Required),
		validation.Field(&d.MessageBuilder, validation.Required),
		validation.Field(&d.CapabilityRegistry, validation.Required),
		validation.Field(&d.FormatterRegistry, validation.Required),
	)
}

// BillingDeps groups billing and usage-tracking dependencies.
type BillingDeps struct {
	ToolLimitResolver      domainllm.ToolLimitResolver    // Resolves tool round limits (tier-ready)
	TokenFinalizer         tokens.TokenFinalizer          // For finalizing tokens on completion/interruption
	CreditAdmissionChecker billing.CreditAdmissionChecker // Pre-stream credit check
	CreditSettler          billing.CreditSettler          // Post-stream credit settlement
	SettlementMode         billing.CreditSettlementMode   // Settlement mode (sync/async)
}

// Validate checks that all billing dependencies are provided.
func (d BillingDeps) Validate() error {
	return validation.ValidateStruct(&d,
		validation.Field(&d.ToolLimitResolver, validation.Required),
		validation.Field(&d.TokenFinalizer, validation.Required),
		validation.Field(&d.CreditAdmissionChecker, validation.Required),
		validation.Field(&d.CreditSettler, validation.Required),
		validation.Field(
			&d.SettlementMode,
			validation.Required,
			validation.In(
				billing.CreditSettlementInlineAuthoritative,
				billing.CreditSettlementDeferredToEnrichment,
			),
		),
	)
}

// InfraDeps groups infrastructure dependencies (config, jobs, logging).
type InfraDeps struct {
	Config   *config.Config
	JobQueue jobs.JobQueue // Background job queue for async operations
	Logger   *slog.Logger
	// ExecutorRegistry is optional. When non-nil, it is used as the shared executor
	// registry so that external components (e.g. SpawnService) can cancel child
	// executors. When nil, a new private registry is created inside the service.
	ExecutorRegistry *ExecutorRegistry
}

// Validate checks that all infrastructure dependencies are provided.
func (d InfraDeps) Validate() error {
	return validation.ValidateStruct(&d,
		validation.Field(&d.Config, validation.Required),
		validation.Field(&d.JobQueue, validation.Required),
		validation.Field(&d.Logger, validation.Required),
	)
}

// StreamingDeps is the top-level dependency struct for NewStreamingOrchestrator.
// Groups 5 sub-structs by concern so callers can see the shape of dependencies at a glance.
type StreamingDeps struct {
	Persistence PersistenceDeps
	Services    ServiceDeps
	Pipeline    PipelineDeps
	Billing     BillingDeps
	Infra       InfraDeps
}

// Validate checks all sub-structs recursively.
func (d StreamingDeps) Validate() error {
	return validation.ValidateStruct(&d,
		validation.Field(&d.Persistence),
		validation.Field(&d.Services),
		validation.Field(&d.Pipeline),
		validation.Field(&d.Billing),
		validation.Field(&d.Infra),
	)
}
