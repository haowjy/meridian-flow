# Phase A3a: .agents/ Namespace + Frontmatter Parser

## Scope
Create the shared frontmatter parser package and the `domain/agents` package with types and interfaces. No service implementations.

## Intent
Every agent-related step (A3b, SM, AI, P1) depends on these foundational types and the frontmatter parser. This is the bootstrap for the entire agents subsystem.

## Files to Create
- `backend/internal/pkg/frontmatter/parser.go` — YAML frontmatter parser
- `backend/internal/pkg/frontmatter/parser_test.go` — parser tests
- `backend/internal/domain/agents/types.go` — Persona, RuntimeSkill, ValidationIssue types
- `backend/internal/domain/agents/interfaces.go` — SkillResolver, PersonaCatalog, AgentImportService, BackfillService, GitFetcher interfaces

## What Changes

### Frontmatter Parser
Extracts YAML between `---` delimiters at the start of a file. Returns:
- Parsed map (or struct via generic unmarshal)
- Remaining body (everything after the closing `---`)
- Error if no frontmatter found or YAML is invalid

```go
// Parse extracts YAML frontmatter and body from markdown content.
// Returns error if no frontmatter delimiters found.
func Parse(content string) (frontmatter map[string]interface{}, body string, err error)

// ParseInto unmarshals frontmatter into a typed struct.
func ParseInto[T any](content string) (T, string, error)
```

### Domain Types (types.go)

```go
type Persona struct {
    Slug        string
    Name        string   // required
    Description string   // required
    Model       string   // required
    Temperature *float64
    MaxTokens   *int
    Tools       []string // nil = inherit all, empty = none
    DisallowedTools []string
    Skills      []string
    UserInvocable         bool // default true
    DisableModelInvocation bool // default false
}

type RuntimeSkill struct {
    Slug        string
    Name        string
    Description string
    Body        string // markdown content after frontmatter
    Trigger     string // "auto" | "manual" | "always"
}

type ValidationIssue struct {
    Path    string
    Field   string
    Message string
}
```

### Interfaces (interfaces.go)
Define the contracts that service layer will implement. No concrete dependencies.

```go
type SkillResolver interface {
    Resolve(ctx context.Context, projectID uuid.UUID, slug string) (*RuntimeSkill, error)
    List(ctx context.Context, projectID uuid.UUID) ([]RuntimeSkill, []ValidationIssue, error)
}

type PersonaCatalog interface {
    ResolvePersona(ctx context.Context, projectID uuid.UUID, slug string) (*Persona, error)
    ListUserPersonas(ctx context.Context, projectID uuid.UUID) ([]Persona, []ValidationIssue, error)
    ListSpawnablePersonas(ctx context.Context, projectID uuid.UUID) ([]Persona, []ValidationIssue, error)
}

type AgentImportService interface {
    ImportFromGit(ctx context.Context, projectID uuid.UUID, url string) error
}

type BackfillService interface {
    BackfillSkills(ctx context.Context, projectID uuid.UUID) error
}

type GitFetcher interface {
    ValidateURL(url string) error
    Clone(ctx context.Context, url string) (string, error) // returns temp dir path
}
```

## Patterns to Follow
- See `backend/internal/domain/llm/` for domain type conventions
- See `backend/internal/domain/skill/project_skill.go` for existing skill types

## Constraints
- Interfaces in domain MUST NOT reference service or repository packages
- Frontmatter parser is a pure utility — no domain imports
- Unknown YAML fields should be allowed (forward compatibility)

## Verification Criteria
- [ ] `make test` passes
- [ ] Frontmatter parser handles: valid YAML, missing frontmatter (error), empty body after frontmatter (allowed), unknown fields (allowed)
- [ ] Domain types compile with all fields from design
- [ ] Interfaces have no concrete dependencies (no service/repository imports)
- [ ] `go vet ./...` clean
