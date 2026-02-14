package seed

import (
	"context"
	"log/slog"
	"os"

	skillSvc "meridian/internal/domain/services/skill"
)

// SkillSeeder handles seeding of project skills via the service layer
type SkillSeeder struct {
	skillService skillSvc.ProjectSkillService
	logger       *slog.Logger
}

// NewSkillSeeder creates a new skill seeder
func NewSkillSeeder(skillService skillSvc.ProjectSkillService, logger *slog.Logger) *SkillSeeder {
	return &SkillSeeder{
		skillService: skillService,
		logger:       logger,
	}
}

// SeedSkills creates skills from seed_data/.meridian/skills/ directory.
// Idempotent: skips skills that already exist (by name).
func (s *SkillSeeder) SeedSkills(ctx context.Context, projectID, userID string) error {
	// Read skill content from seed data
	content, err := os.ReadFile("scripts/seed_data/.meridian/skills/test-skill/SKILL.md")
	if err != nil {
		return err
	}

	// Check if skill already exists (idempotency)
	existing, err := s.skillService.ListSkills(ctx, userID, projectID)
	if err != nil {
		return err
	}
	for _, skill := range existing {
		if skill.Name == "test-skill" {
			s.logger.Info("skill already exists, skipping", "name", "test-skill")
			return nil
		}
	}

	// Create skill via service layer (creates folder + DB record)
	_, err = s.skillService.CreateSkill(ctx, userID, skillSvc.CreateSkillRequest{
		ProjectID:     projectID,
		Name:          "test-skill",
		Description:   "Test Skill - Verification Skill",
		Content:       string(content),
		UserInvocable: true,
	})
	if err != nil {
		return err
	}

	s.logger.Info("seeded skill", "name", "test-skill")
	return nil
}
