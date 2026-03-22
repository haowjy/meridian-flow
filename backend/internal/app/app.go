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
	UserPrefs *domains.UserPrefsModule
	Workers   *Workers
	JobQueue  jobs.JobQueue
}
