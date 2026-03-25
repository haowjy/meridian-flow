// Package agents defines the domain types and service interfaces for the
// .agents/ namespace — personas, runtime skills, and the catalog services
// that resolve them from the document tree.
package agents

// Persona describes an agent profile stored at .agents/agents/<slug>.md.
// Fields map directly to the YAML frontmatter spec; yaml tags use hyphens
// to match the Claude Code agent-spec field names.
type Persona struct {
	// Slug is the normalised file basename (derived at load time, not stored
	// in frontmatter). Example: "writing-coach".
	Slug string `json:"slug"`

	// Required frontmatter fields.
	Name        string `json:"name"        yaml:"name"`
	Description string `json:"description" yaml:"description"`

	// Model/provider — "inherit" means use the parent context's model.
	Model    string `json:"model,omitempty"    yaml:"model"`
	Provider string `json:"provider,omitempty" yaml:"provider"`

	// Tool filtering. nil Tools means inherit all available tools.
	// An empty slice means no tools. DisallowedTools removes from whichever
	// set was determined by Tools.
	Tools           []string `json:"tools,omitempty"            yaml:"tools"`
	DisallowedTools []string `json:"disallowed_tools,omitempty" yaml:"disallowed-tools"`

	// Skills loaded into context at startup. Personas do not inherit skills
	// from the parent context; the list here is the complete set.
	Skills []string `json:"skills,omitempty" yaml:"skills"`

	// Sampling parameters — absent means use provider defaults.
	Temperature *float64 `json:"temperature,omitempty" yaml:"temperature"`
	MaxTokens   *int     `json:"max_tokens,omitempty"  yaml:"max_tokens"`

	// Agentic-run controls.
	MaxTurns   *int   `json:"max_turns,omitempty"  yaml:"max-turns"`
	Background bool   `json:"background,omitempty" yaml:"background"`
	Effort     string `json:"effort,omitempty"     yaml:"effort"`

	// Invocation policy.
	// UserInvocable controls whether the persona appears in the user picker UI.
	// Default: true. Use *bool so that YAML omission (nil) can be distinguished
	// from an explicit false. Callers treat nil as "apply default true".
	UserInvocable *bool `json:"user_invocable" yaml:"user-invocable"`
	// DisableModelInvocation prevents other agents from spawning this persona.
	// Default: false.
	DisableModelInvocation bool `json:"disable_model_invocation" yaml:"disable-model-invocation"`

	// SystemPrompt holds the markdown body after the frontmatter block.
	// It is not serialised to JSON or YAML — callers populate it at load time.
	SystemPrompt string `json:"-" yaml:"-"`

	// SourcePath is the document-tree path of the file this persona was
	// loaded from. Example: ".agents/agents/writing-coach.md".
	SourcePath string `json:"source_path"`
}

// RuntimeSkill is the resolved, runtime view of a skill. It is assembled
// from .agents/skills/<slug>/SKILL.md (file-first) with a fallback to the
// legacy project_skills table when no file copy exists.
//
// Invocation policy note: earlier specs modelled invocation as a single
// "Trigger" enum. That was decomposed into UserInvocable + ModelInvocable
// boolean fields for cleaner permission modeling — each axis can be toggled
// independently without adding new enum values.
//
// Nil-means-true convention: Enabled, UserInvocable, and ModelInvocable are
// *bool so that YAML omission can be distinguished from an explicit false.
// Callers must treat nil as "apply default true" for these three fields.
type RuntimeSkill struct {
	// Identity.
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`

	// Content is the markdown body after the SKILL.md frontmatter block.
	Content string `json:"content"`

	// Enabled gates whether the skill participates in any resolution.
	// Default: true. Nil means "apply default true" (see nil-means-true note above).
	Enabled *bool `json:"enabled"`

	// Invocation policy — both default to true for backwards compatibility.
	// UserInvocable: whether the skill appears in user-facing /skill commands.
	// ModelInvocable: whether prompt injection and skill_list/skill_invoke use it.
	// Nil means "apply default true" for each field (see nil-means-true note above).
	UserInvocable  *bool `json:"user_invocable"`
	ModelInvocable *bool `json:"model_invocable"`

	// Optional ordering and version labels from frontmatter.
	Position *int    `json:"position,omitempty"`
	Version  *string `json:"version,omitempty"`

	// Source indicates where the skill was loaded from.
	// "file" for .agents/ document-tree; "db" for legacy project_skills.
	Source string `json:"source"`

	// SourcePath is the document-tree path of the SKILL.md file, when Source
	// is "file". Empty when Source is "db".
	SourcePath string `json:"source_path,omitempty"`
}

// BoolDefaultTrue resolves the nil-means-true convention used by *bool fields
// in Persona and RuntimeSkill. It returns the pointed-to value when non-nil,
// or true when the pointer is nil (i.e. the field was omitted from YAML).
//
// Example usage (downstream loader):
//
//	if BoolDefaultTrue(skill.Enabled) { ... }
func BoolDefaultTrue(b *bool) bool {
	if b == nil {
		return true
	}
	return *b
}

// ValidationIssue records a single problem found during catalog enumeration
// or explicit resolution. Multiple issues may be returned for a single file.
type ValidationIssue struct {
	// Path is the document-tree path of the offending file.
	// Example: ".agents/agents/broken.md"
	Path string `json:"path"`

	// Field is the frontmatter field name that caused the issue, or empty
	// when the problem is structural (e.g. missing frontmatter entirely).
	Field string `json:"field,omitempty"`

	// Message is a human-readable description of the problem.
	Message string `json:"message"`
}
