package skill

import (
	"fmt"
	"regexp"

	"gopkg.in/yaml.v3"

	"meridian/internal/config"
	"meridian/internal/domain"
	skilldomain "meridian/internal/domain/skill"
)

// skillMDFrontmatter is the struct for reading and writing SKILL.md YAML frontmatter.
// Hyphenated yaml tags match the SKILL.md spec.
type skillMDFrontmatter struct {
	Name                   string  `yaml:"name"`
	Description            string  `yaml:"description,omitempty"`
	UserInvocable          *bool   `yaml:"user-invocable,omitempty"`
	DisableModelInvocation bool    `yaml:"disable-model-invocation,omitempty"`
	Position               *int    `yaml:"position,omitempty"`
	Version                *string `yaml:"version,omitempty"`
}

// buildSkillMDContent serializes a ProjectSkill to SKILL.md format.
// Format: "---\n<YAML frontmatter>---\n<skill body>".
func buildSkillMDContent(skill *skilldomain.ProjectSkill) (string, error) {
	meta := skill.GetMetadata()

	fm := skillMDFrontmatter{
		Name:        skill.Name,
		Description: skill.Description,
	}
	if !meta.UserInvocable {
		f := false
		fm.UserInvocable = &f
	}
	if meta.DisableModelInvocation {
		fm.DisableModelInvocation = true
	}
	if skill.Position > 0 {
		p := skill.Position
		fm.Position = &p
	}

	yamlBytes, err := yaml.Marshal(fm)
	if err != nil {
		return "", fmt.Errorf("marshal skill frontmatter: %w", err)
	}

	// yaml.Marshal appends a trailing newline so "---\n<yaml>---\n<body>" is correct.
	return "---\n" + string(yamlBytes) + "---\n" + skill.Content, nil
}

func validateSkillName(name string) error {
	// Skill names should be URL-safe identifiers.
	// Allowed: letters (mixed case), numbers, hyphens.
	// Must start and end with alphanumeric (not hyphen).
	matched, _ := regexp.MatchString(`^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$`, name)
	if !matched {
		return domain.NewValidationErrorWithField(
			"invalid skill name: must be alphanumeric with hyphens, cannot start or end with hyphen, e.g., 'WritingCoach' or 'my-skill'",
			"name",
		)
	}
	if len(name) < 1 || len(name) > 50 {
		return domain.NewValidationErrorWithField(
			"skill name must be between 1 and 50 characters",
			"name",
		)
	}
	return nil
}

func validateSkillDescription(description string) error {
	if len(description) > config.MaxSkillDescriptionLength {
		return domain.NewValidationErrorWithField(
			fmt.Sprintf("description must be %d characters or less", config.MaxSkillDescriptionLength),
			"description",
		)
	}
	return nil
}
