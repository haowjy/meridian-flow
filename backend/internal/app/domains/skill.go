package domains

import (
	"net/http"

	"meridian/internal/config"
	"meridian/internal/domain"
	domainagents "meridian/internal/domain/agents"
	authdomain "meridian/internal/domain/auth"
	domaindocsys "meridian/internal/domain/docsystem"
	skilldomain "meridian/internal/domain/skill"
	"meridian/internal/handler"
	postgresSkill "meridian/internal/repository/postgres/skill"
	serviceAgents "meridian/internal/service/agents"
	serviceSkill "meridian/internal/service/skill"
)

// SkillModule wires project-skill services and handlers.
type SkillModule struct {
	Service         skilldomain.ProjectSkillService
	Resolver        domainagents.SkillResolver // File-backed; reads .agents/skills/<slug>/SKILL.md
	Handler         *handler.ProjectSkillHandler
	BackfillHandler *handler.AgentAdminHandler // POST /api/projects/{id}/agents/backfill
}

// SkillDeps captures cross-domain deps needed by skill wiring.
type SkillDeps struct {
	DocumentRepo     domaindocsys.DocumentStore
	FolderRepo       domaindocsys.FolderStore
	NamespaceService domaindocsys.NamespaceService
	Authorizer       authdomain.ResourceAuthorizer
	TxManager        domain.TransactionManager
}

// NewSkillModule creates project-skill service, file-backed resolver, and handlers.
func NewSkillModule(infra InfrastructureDeps, cfg *config.Config, deps SkillDeps) (*SkillModule, error) {
	skillRepo := postgresSkill.NewProjectSkillRepository(infra.RepoConfig)
	// File-backed resolver: reads .agents/skills/<slug>/SKILL.md; no DB fallback.
	skillResolver := serviceAgents.NewFileSkillResolver(deps.DocumentRepo, deps.FolderRepo, infra.Logger)
	skillService := serviceSkill.NewFileProjectSkillService(
		deps.DocumentRepo,
		deps.FolderRepo,
		deps.NamespaceService,
		deps.Authorizer,
		skillResolver,
		deps.TxManager,
		infra.Logger,
	)

	// Backfill service: migrates legacy DB skills to SKILL.md files.
	backfillSvc := serviceAgents.NewBackfillService(skillRepo, deps.DocumentRepo, deps.FolderRepo, infra.Logger)
	backfillHandler := handler.NewAgentAdminHandler(backfillSvc, infra.Logger, cfg)

	return &SkillModule{
		Service:         skillService,
		Resolver:        skillResolver,
		Handler:         handler.NewProjectSkillHandler(skillService, infra.Logger, cfg),
		BackfillHandler: backfillHandler,
	}, nil
}

// RegisterRoutes registers project-skill routes.
func (m *SkillModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects/{projectId}/skills", m.Handler.ListSkills)
	mux.HandleFunc("POST /api/projects/{projectId}/skills", m.Handler.CreateSkill)
	mux.HandleFunc("PUT /api/projects/{projectId}/skills/reorder", m.Handler.ReorderSkills)
	mux.HandleFunc("GET /api/projects/{projectId}/skills/{skillId}", m.Handler.GetSkill)
	mux.HandleFunc("PUT /api/projects/{projectId}/skills/{skillId}", m.Handler.UpdateSkill)
	mux.HandleFunc("DELETE /api/projects/{projectId}/skills/{skillId}", m.Handler.DeleteSkill)

	// Admin: backfill legacy DB skills to .agents/skills/<slug>/SKILL.md files.
	mux.HandleFunc("POST /api/projects/{id}/agents/backfill", m.BackfillHandler.BackfillSkills)
}
