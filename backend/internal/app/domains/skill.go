package domains

import (
	"net/http"

	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	domaindocsys "meridian/internal/domain/docsystem"
	skilldomain "meridian/internal/domain/skill"
	"meridian/internal/handler"
	postgresSkill "meridian/internal/repository/postgres/skill"
	serviceSkill "meridian/internal/service/skill"
)

// SkillModule wires project-skill services and handlers.
type SkillModule struct {
	Service skilldomain.ProjectSkillService
	Handler *handler.ProjectSkillHandler
}

// SkillDeps captures cross-domain deps needed by skill wiring.
type SkillDeps struct {
	FolderRepo       domaindocsys.FolderStore
	NamespaceService domaindocsys.NamespaceService
	Authorizer       authdomain.ResourceAuthorizer
	TxManager        domain.TransactionManager
}

// NewSkillModule creates project-skill service and handler.
func NewSkillModule(infra InfrastructureDeps, cfg *config.Config, deps SkillDeps) (*SkillModule, error) {
	skillRepo := postgresSkill.NewProjectSkillRepository(infra.RepoConfig)
	skillService := serviceSkill.NewProjectSkillService(
		skillRepo,
		deps.FolderRepo,
		deps.NamespaceService,
		deps.Authorizer,
		deps.TxManager,
		infra.Logger,
	)

	return &SkillModule{
		Service: skillService,
		Handler: handler.NewProjectSkillHandler(skillService, infra.Logger, cfg),
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
}
