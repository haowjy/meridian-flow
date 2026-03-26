package app

import (
	"meridian/internal/app/domains"
	"meridian/internal/jobs"
)

// Application holds all initialized modules and shared infra.
type Application struct {
	Infra     *Infrastructure
	Docsystem *domains.DocsystemModule
	Auth      *domains.AuthModule
	Billing   *domains.BillingModule
	Skill     *domains.SkillModule
	Collab    *domains.CollabModule
	LLM       *domains.LLMModule
	WorkItem  *domains.WorkItemModule
	UserPrefs *domains.UserPrefsModule
	Agent     *domains.AgentModule
	Workers   *Workers
	JobQueue  jobs.JobQueue
}
