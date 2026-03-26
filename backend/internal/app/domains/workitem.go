package domains

import (
	"net/http"

	"meridian/internal/config"
	domaindocsys "meridian/internal/domain/docsystem"
	domainwi "meridian/internal/domain/workitem"
	"meridian/internal/handler"
	postgresWI "meridian/internal/repository/postgres/workitem"
	svcwi "meridian/internal/service/workitem"
)

// WorkItemDeps carries cross-domain dependencies required by the work item module.
type WorkItemDeps struct {
	// ProjectRepo is used to verify project membership on every operation.
	ProjectRepo domaindocsys.ProjectStore
}

// WorkItemModule wires the work item repository, service, and handler.
type WorkItemModule struct {
	Store   domainwi.Store
	Service domainwi.Service
	Handler *handler.WorkItemHandler
}

// NewWorkItemModule creates the work item store, service, and handler.
func NewWorkItemModule(infra InfrastructureDeps, cfg *config.Config, deps WorkItemDeps) (*WorkItemModule, error) {
	store := postgresWI.NewWorkItemStore(infra.RepoConfig)
	svc := svcwi.NewService(store, deps.ProjectRepo, infra.Logger)
	h := handler.NewWorkItemHandler(svc, infra.Logger, cfg)

	return &WorkItemModule{
		Store:   store,
		Service: svc,
		Handler: h,
	}, nil
}

// RegisterRoutes registers work item HTTP routes under /api/projects/{id}/work-items.
func (m *WorkItemModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/projects/{id}/work-items", m.Handler.CreateWorkItem)
	mux.HandleFunc("GET /api/projects/{id}/work-items", m.Handler.ListWorkItems)
	mux.HandleFunc("GET /api/projects/{id}/work-items/{slug}", m.Handler.GetWorkItem)
	mux.HandleFunc("PUT /api/projects/{id}/work-items/{slug}", m.Handler.UpdateWorkItem)
	mux.HandleFunc("POST /api/projects/{id}/work-items/{slug}/complete", m.Handler.CompleteWorkItem)
	mux.HandleFunc("POST /api/projects/{id}/work-items/{slug}/reopen", m.Handler.ReopenWorkItem)
	mux.HandleFunc("DELETE /api/projects/{id}/work-items/{slug}", m.Handler.DeleteWorkItem)
}
