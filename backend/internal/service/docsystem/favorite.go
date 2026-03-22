package docsystem

import (
	"context"
	"log/slog"

	domaindocsys "meridian/internal/domain/docsystem"
)

// favoriteService implements the FavoriteService interface
type favoriteService struct {
	favoriteRepo domaindocsys.FavoriteStore
	projectRepo  domaindocsys.ProjectStore
	logger       *slog.Logger
}

// NewFavoriteService creates a new favorite service
func NewFavoriteService(
	favoriteRepo domaindocsys.FavoriteStore,
	projectRepo domaindocsys.ProjectStore,
	logger *slog.Logger,
) domaindocsys.FavoriteService {
	return &favoriteService{
		favoriteRepo: favoriteRepo,
		projectRepo:  projectRepo,
		logger:       logger,
	}
}

// AddFavorite marks a project as favorite for a user
func (s *favoriteService) AddFavorite(ctx context.Context, userID, projectID string) error {
	// Verify project exists and user owns it
	_, err := s.projectRepo.GetByID(ctx, projectID, userID)
	if err != nil {
		return err
	}

	if err := s.favoriteRepo.Add(ctx, userID, projectID); err != nil {
		return err
	}

	s.logger.Debug("project marked as favorite",
		"project_id", projectID,
		"user_id", userID,
	)

	return nil
}

// RemoveFavorite unmarks a project as favorite for a user
func (s *favoriteService) RemoveFavorite(ctx context.Context, userID, projectID string) error {
	// Verify project exists and user owns it
	_, err := s.projectRepo.GetByID(ctx, projectID, userID)
	if err != nil {
		return err
	}

	if err := s.favoriteRepo.Remove(ctx, userID, projectID); err != nil {
		return err
	}

	s.logger.Debug("project unmarked as favorite",
		"project_id", projectID,
		"user_id", userID,
	)

	return nil
}
