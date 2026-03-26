package app

import (
	"fmt"

	"meridian/internal/app/domains"
	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/jobs"
	serviceLLM "meridian/internal/service/llm"
)

// NewApplication wires all domain modules in dependency order.
func NewApplication(cfg *config.Config, infra *Infrastructure) (*Application, error) {
	infraDeps := domains.InfrastructureDeps{
		RepoConfig:  infra.RepoConfig,
		JWTVerifier: infra.JWTVerifier,
		Logger:      infra.Logger,
	}

	toolLimitResolver := serviceLLM.NewConfigToolLimitResolver(cfg.LLM.MaxToolRounds)

	docsystemModule, err := domains.NewDocsystemModule(infraDeps, cfg)
	if err != nil {
		return nil, fmt.Errorf("docsystem module: %w", err)
	}

	authModule, err := domains.NewAuthModule(infraDeps, cfg, domains.AuthDeps{
		ProjectRepo:  docsystemModule.ProjectRepo,
		FolderRepo:   docsystemModule.FolderRepo,
		DocumentRepo: docsystemModule.DocumentRepo,
	})
	if err != nil {
		return nil, fmt.Errorf("auth module: %w", err)
	}

	capabilityRegistry, err := capabilities.NewRegistry()
	if err != nil {
		return nil, fmt.Errorf("capability registry: %w", err)
	}
	infra.Logger.Info("capability registry initialized")

	billingModule, err := domains.NewBillingModule(infraDeps, cfg, capabilityRegistry)
	if err != nil {
		return nil, fmt.Errorf("billing module: %w", err)
	}

	docsystemModule.AttachAuthorizer(authModule.Authorizer)
	authModule.AttachCreditGranter(billingModule.CreditGranter)

	skillModule, err := domains.NewSkillModule(infraDeps, cfg, domains.SkillDeps{
		DocumentRepo:     docsystemModule.DocumentRepo,
		FolderRepo:       docsystemModule.FolderRepo,
		NamespaceService: docsystemModule.NamespaceService,
		Authorizer:       authModule.Authorizer,
		TxManager:        docsystemModule.TxManager,
	})
	if err != nil {
		return nil, fmt.Errorf("skill module: %w", err)
	}

	collabModule, err := domains.NewCollabModule(infraDeps, cfg, domains.CollabDeps{
		DocumentRepo:      docsystemModule.DocumentRepo,
		Authorizer:        authModule.Authorizer,
		TxManager:         docsystemModule.TxManager,
		AutoapplyResolver: docsystemModule.AutoapplyResolver,
	})
	if err != nil {
		return nil, fmt.Errorf("collab module: %w", err)
	}

	jobQueue := jobs.NewInMemoryQueue(
		5,
		1000,
		infra.Logger,
	)

	workItemModule, err := domains.NewWorkItemModule(infraDeps, cfg, domains.WorkItemDeps{
		ProjectRepo: docsystemModule.ProjectRepo,
	})
	if err != nil {
		return nil, fmt.Errorf("work item module: %w", err)
	}

	llmModule, err := domains.NewLLMModule(infraDeps, cfg, domains.LLMCrossDeps{
		AdmissionChecker:   billingModule.AdmissionChecker,
		CreditSettler:      billingModule.CreditSettler,
		SettlementMode:     billingModule.SettlementMode,
		MutationStrategy:   collabModule.MutationStrategy,
		DocumentSvc:        docsystemModule.DocumentService,
		FolderSvc:          docsystemModule.FolderService,
		SkillResolver:      skillModule.Resolver,
		Authorizer:         authModule.Authorizer,
		ProjectRepo:        docsystemModule.ProjectRepo,
		FolderRepo:         docsystemModule.FolderRepo,
		TxManager:          docsystemModule.TxManager,
		ThreadRepo:         authModule.LLMRepos.ThreadRepo,
		TurnRepo:           authModule.LLMRepos.TurnRepo,
		ToolLimitResolver:  toolLimitResolver,
		CapabilityRegistry: capabilityRegistry,
		JobQueue:           jobQueue,
		WorkItemSvc:        workItemModule.Service,
	})
	if err != nil {
		return nil, fmt.Errorf("llm module: %w", err)
	}

	userPrefsModule, err := domains.NewUserPrefsModule(infraDeps, cfg)
	if err != nil {
		return nil, fmt.Errorf("userprefs module: %w", err)
	}

	agentModule, err := domains.NewAgentModule(infraDeps, cfg, domains.AgentDeps{
		DocumentRepo: docsystemModule.DocumentRepo,
		FolderRepo:   docsystemModule.FolderRepo,
		TxManager:    docsystemModule.TxManager,
		Authorizer:   authModule.Authorizer,
	})
	if err != nil {
		return nil, fmt.Errorf("agent module: %w", err)
	}

	application := &Application{
		Infra:     infra,
		Docsystem: docsystemModule,
		Auth:      authModule,
		Billing:   billingModule,
		Skill:     skillModule,
		Collab:    collabModule,
		LLM:       llmModule,
		WorkItem:  workItemModule,
		UserPrefs: userPrefsModule,
		Agent:     agentModule,
		JobQueue:  jobQueue,
	}
	application.Workers = NewWorkers(cfg, application, infra.Logger)

	infra.Logger.Info("services initialized")
	return application, nil
}
