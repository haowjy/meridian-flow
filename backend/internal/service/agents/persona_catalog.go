package agents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"

	"meridian/internal/capabilities"
	"meridian/internal/domain"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
	"meridian/internal/pkg/frontmatter"
)

// filePersonaCatalog implements domain/agents.PersonaCatalog backed by the
// .agents/agents/ document tree. File-only — no DB fallback.
//
// N+1 note: ListByFolder returns metadata without content, so a secondary
// GetByID call is required per document to load the system-prompt body.
// This is acceptable because persona catalogues are small (< ~20 per project)
// and only loaded at agent-spawn time, not on every request.
type filePersonaCatalog struct {
	docRepo            domaindocsys.DocumentReader
	folderRepo         domaindocsys.FolderStore
	capabilityRegistry *capabilities.Registry // nil means skip model validation
	logger             *slog.Logger
}

// Compile-time interface assertion.
var _ domainagents.PersonaCatalog = (*filePersonaCatalog)(nil)

// NewFilePersonaCatalog creates a PersonaCatalog backed by the .agents/
// document tree. Both docRepo and folderRepo are required.
// capabilityRegistry is optional; pass nil to skip model availability checks.
func NewFilePersonaCatalog(
	docRepo domaindocsys.DocumentReader,
	folderRepo domaindocsys.FolderStore,
	capabilityRegistry *capabilities.Registry,
	logger *slog.Logger,
) domainagents.PersonaCatalog {
	return &filePersonaCatalog{
		docRepo:            docRepo,
		folderRepo:         folderRepo,
		capabilityRegistry: capabilityRegistry,
		logger:             logger,
	}
}

// ResolvePersona returns the persona for the given slug.
//
// Returns domainerrors.PersonaNotFound when the file does not exist, and
// domainerrors.PersonaInvalid when it exists but has malformed frontmatter or
// a missing required field.
func (c *filePersonaCatalog) ResolvePersona(ctx context.Context, projectID uuid.UUID, slug string) (*domainagents.Persona, error) {
	path := fmt.Sprintf(".agents/agents/%s.md", slug)

	doc, err := c.docRepo.GetByPath(ctx, path, projectID.String())
	if err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			return nil, domainerrors.PersonaNotFound(slug)
		}
		return nil, fmt.Errorf("persona catalog: read %s: %w", path, err)
	}

	persona, parseErr := parsePersonaDoc(doc, slug, path)
	if parseErr != nil {
		c.logger.Warn("persona file invalid",
			"slug", slug,
			"path", path,
			"error", parseErr,
		)
		return nil, domainerrors.PersonaInvalid(parseErr.Error())
	}

	if modelErr := c.validatePersonaModel(persona); modelErr != nil {
		c.logger.Warn("persona model unavailable",
			"slug", slug,
			"path", path,
			"model", persona.Model,
			"error", modelErr,
		)
		return nil, domainerrors.PersonaInvalid(modelErr.Error())
	}

	return persona, nil
}

// ListUserPersonas returns all personas whose UserInvocable field is true (or
// nil, which defaults to true per the nil-means-true convention). Invalid
// entries are excluded from the personas slice and appended to issues.
//
// Returns (nil, nil, nil) when the .agents/agents/ folder does not yet exist.
func (c *filePersonaCatalog) ListUserPersonas(ctx context.Context, projectID uuid.UUID) ([]domainagents.Persona, []domainagents.ValidationIssue, error) {
	all, issues, err := c.listAll(ctx, projectID)
	if err != nil {
		return nil, nil, err
	}

	var result []domainagents.Persona
	for _, p := range all {
		if domainagents.BoolDefaultTrue(p.UserInvocable) {
			result = append(result, p)
		}
	}
	return result, issues, nil
}

// ListSpawnablePersonas returns all personas that other agents may spawn,
// i.e. those where DisableModelInvocation is false (the default). Invalid
// entries are excluded and appended to issues.
//
// Returns (nil, nil, nil) when the .agents/agents/ folder does not yet exist.
func (c *filePersonaCatalog) ListSpawnablePersonas(ctx context.Context, projectID uuid.UUID) ([]domainagents.Persona, []domainagents.ValidationIssue, error) {
	all, issues, err := c.listAll(ctx, projectID)
	if err != nil {
		return nil, nil, err
	}

	var result []domainagents.Persona
	for _, p := range all {
		if !p.DisableModelInvocation {
			result = append(result, p)
		}
	}
	return result, issues, nil
}

// listAll reads every .md document in .agents/agents/, parses each one, and
// returns the valid personas alongside any validation issues encountered.
func (c *filePersonaCatalog) listAll(ctx context.Context, projectID uuid.UUID) ([]domainagents.Persona, []domainagents.ValidationIssue, error) {
	agentsFolder, err := c.folderRepo.GetByPath(ctx, projectID.String(), ".agents/agents")
	if err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			// No agents folder yet — not an error, just no personas.
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("persona catalog: locate agents folder: %w", err)
	}

	// ListByFolder returns metadata only (no content), so a secondary GetByID
	// is required to load the system-prompt body for each document.
	metaDocs, err := c.docRepo.ListByFolder(ctx, &agentsFolder.ID, projectID.String())
	if err != nil {
		return nil, nil, fmt.Errorf("persona catalog: list agents folder: %w", err)
	}

	var personas []domainagents.Persona
	var issues []domainagents.ValidationIssue

	for _, meta := range metaDocs {
		// Only process markdown files; ignore any other file types in the folder.
		if meta.Extension != ".md" {
			continue
		}

		slug := meta.Name // Name field holds the basename without extension.
		path := fmt.Sprintf(".agents/agents/%s.md", slug)

		// Load full document content (metadata-only from ListByFolder is insufficient).
		fullDoc, err := c.docRepo.GetByID(ctx, meta.ID, projectID.String())
		if err != nil {
			issues = append(issues, domainagents.ValidationIssue{
				Path:    path,
				Message: fmt.Sprintf("failed to load: %v", err),
			})
			c.logger.Warn("persona file load failed, skipping",
				"slug", slug,
				"path", path,
				"error", err,
			)
			continue
		}

		persona, parseErr := parsePersonaDoc(fullDoc, slug, path)
		if parseErr != nil {
			issues = append(issues, domainagents.ValidationIssue{
				Path:    path,
				Message: parseErr.Error(),
			})
			c.logger.Warn("persona file invalid, skipping",
				"slug", slug,
				"path", path,
				"error", parseErr,
			)
			continue
		}

		// Model validation: add issue but keep persona in list for visibility.
		// Callers that need the persona to be fully runnable (ResolvePersona)
		// apply a stricter check; list operations surface the issue without
		// hiding the entry from the catalog view.
		if modelErr := c.validatePersonaModel(persona); modelErr != nil {
			issues = append(issues, domainagents.ValidationIssue{
				Path:    path,
				Field:   "model",
				Message: modelErr.Error(),
			})
			c.logger.Warn("persona model unavailable",
				"slug", slug,
				"path", path,
				"model", persona.Model,
				"error", modelErr,
			)
			// Intentional fall-through: keep persona in result.
		}

		personas = append(personas, *persona)
	}

	return personas, issues, nil
}

// validatePersonaModel checks that the persona's model field names a model
// that is registered in the capability registry. Returns nil when:
//   - no registry is configured (validation skipped)
//   - persona.Model is empty (model is inherited from caller context)
//   - the model is found in the registry
//
// When persona.Provider is set the check is scoped to that provider; otherwise
// all configured providers are searched in iteration order.
func (c *filePersonaCatalog) validatePersonaModel(persona *domainagents.Persona) error {
	if c.capabilityRegistry == nil || persona.Model == "" {
		return nil
	}

	if persona.Provider != "" {
		_, err := c.capabilityRegistry.GetModelCapabilities(persona.Provider, persona.Model)
		if err != nil {
			return fmt.Errorf("model %q unavailable for provider %q", persona.Model, persona.Provider)
		}
		return nil
	}

	// No provider specified — accept if model is known in any configured provider.
	for _, provider := range c.capabilityRegistry.GetAllProviders() {
		_, err := c.capabilityRegistry.GetModelCapabilities(provider, persona.Model)
		if err == nil {
			return nil
		}
	}
	return fmt.Errorf("model %q not found in any configured provider", persona.Model)
}

// parsePersonaDoc parses the content of a persona .md file into a Persona.
// The Persona type has proper yaml tags so it can be parsed directly.
// Slug, SourcePath, and SystemPrompt are set after parsing (derived, not in frontmatter).
func parsePersonaDoc(doc *domaindocsys.Document, slug, path string) (*domainagents.Persona, error) {
	persona, systemPrompt, err := frontmatter.ParseInto[domainagents.Persona](doc.Content)
	if err != nil {
		return nil, fmt.Errorf("invalid frontmatter: %w", err)
	}

	if persona.Name == "" {
		return nil, fmt.Errorf("missing required field: name")
	}

	// Derived fields — always overwrite even if YAML happened to contain them.
	persona.Slug = slug
	persona.SystemPrompt = systemPrompt
	persona.SourcePath = path

	return &persona, nil
}
