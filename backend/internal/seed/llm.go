package seed

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"meridian/internal/repository/postgres"
)

// LLMSeeder handles seeding of LLM-related data (chats, turns, content blocks, responses)
type LLMSeeder struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

// NewLLMSeeder creates a new LLM seeder
func NewLLMSeeder(pool *pgxpool.Pool, tables *postgres.TableNames, logger *slog.Logger) *LLMSeeder {
	return &LLMSeeder{
		pool:   pool,
		tables: tables,
		logger: logger,
	}
}

// SeedChatData creates sample chat data demonstrating tree structure and branching
func (s *LLMSeeder) SeedChatData(ctx context.Context, projectID, userID string) error {
	now := time.Now()

	// Create a sample chat
	chatID := "11111111-1111-1111-1111-111111111111"
	query := `INSERT INTO ` + s.tables.Chats + ` (id, project_id, user_id, title, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO NOTHING`
	_, err := s.pool.Exec(ctx, query, chatID, projectID, userID, "Sample Chat - Story Analysis", now, now)
	if err != nil {
		return err
	}

	// Build a conversation tree demonstrating branching
	// Structure:
	//   Turn 1 (user): "Analyze the protagonist's character arc"
	//     └─ Turn 2 (assistant): "The protagonist shows growth..."
	//          ├─ Turn 3 (user): "What about the antagonist?"
	//          │    └─ Turn 4 (assistant): "The antagonist serves as..."
	//          └─ Turn 3' (user): "How does this compare to Chapter 2?"
	//               └─ Turn 4' (assistant): "Comparing the chapters..."

	// Turn 1: User message
	turn1ID := "22222222-2222-2222-2222-222222222221"
	if err := s.insertTurn(ctx, turn1ID, chatID, nil, "user", "complete", now); err != nil {
		return err
	}
	// Add content blocks for turn 1 (text + reference)
	if err := s.insertContentBlock(ctx, turn1ID, 0, "text", "Analyze the protagonist's character arc", "", now); err != nil {
		return err
	}
	// Note: In real usage, client would send document content snapshot
	// For seed data, we just demonstrate the structure with a mock reference
	if err := s.insertContentBlock(ctx, turn1ID, 1, "reference", "[Character: Protagonist snapshot from client]", "document", now); err != nil {
		return err
	}

	// Turn 2: Assistant response to turn 1
	turn2ID := "22222222-2222-2222-2222-222222222222"
	if err := s.insertTurn(ctx, turn2ID, chatID, &turn1ID, "assistant", "complete", now.Add(1*time.Second)); err != nil {
		return err
	}
	if err := s.insertAssistantResponse(ctx, turn2ID,
		"The user wants analysis of character development throughout the story.",
		"The protagonist shows significant growth throughout the narrative. Starting as a reluctant hero, they gradually embrace their role and demonstrate increasing agency. Key turning points include the confrontation in Chapter 3 and the decision in Chapter 7.",
		150, "claude-3-5-sonnet-20241022", now.Add(1*time.Second)); err != nil {
		return err
	}

	// Turn 3: User branches to ask about antagonist (parent = turn 2)
	turn3ID := "22222222-2222-2222-2222-222222222223"
	if err := s.insertTurn(ctx, turn3ID, chatID, &turn2ID, "user", "complete", now.Add(2*time.Second)); err != nil {
		return err
	}
	if err := s.insertContentBlock(ctx, turn3ID, 0, "text", "What about the antagonist?", "", now.Add(2*time.Second)); err != nil {
		return err
	}

	// Turn 4: Assistant response about antagonist
	turn4ID := "22222222-2222-2222-2222-222222222224"
	if err := s.insertTurn(ctx, turn4ID, chatID, &turn3ID, "assistant", "complete", now.Add(3*time.Second)); err != nil {
		return err
	}
	if err := s.insertAssistantResponse(ctx, turn4ID,
		"Now analyzing the antagonist based on the established protagonist analysis.",
		"The antagonist serves as a perfect foil to the protagonist's growth. While the protagonist learns to embrace change, the antagonist remains rigidly committed to their original worldview. This creates compelling dramatic tension.",
		120, "claude-3-5-sonnet-20241022", now.Add(3*time.Second)); err != nil {
		return err
	}

	// Turn 3': Alternative branch from turn 2 (demonstrates branching!)
	turn3AltID := "22222222-2222-2222-2222-222222222233"
	if err := s.insertTurn(ctx, turn3AltID, chatID, &turn2ID, "user", "complete", now.Add(4*time.Second)); err != nil {
		return err
	}
	if err := s.insertContentBlock(ctx, turn3AltID, 0, "text", "How does this compare to Chapter 2?", "", now.Add(4*time.Second)); err != nil {
		return err
	}

	// Turn 4': Assistant response on alternative branch
	turn4AltID := "22222222-2222-2222-2222-222222222244"
	if err := s.insertTurn(ctx, turn4AltID, chatID, &turn3AltID, "assistant", "complete", now.Add(5*time.Second)); err != nil {
		return err
	}
	if err := s.insertAssistantResponse(ctx, turn4AltID,
		"Comparing character development across chapters.",
		"Comparing to Chapter 2, we see accelerated growth. In Chapter 2, the protagonist was still questioning their capabilities. By the point we're analyzing, they've moved from doubt to decisive action. This represents a complete transformation of their self-perception.",
		140, "claude-3-5-sonnet-20241022", now.Add(5*time.Second)); err != nil {
		return err
	}

	return nil
}

// Helper functions for inserting chat data
func (s *LLMSeeder) insertTurn(ctx context.Context, turnID, chatID string, parentID *string, role, status string, createdAt time.Time) error {
	query := `INSERT INTO ` + s.tables.Turns + ` (id, chat_id, parent_id, role, status, created_at, completed_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO NOTHING`
	_, err := s.pool.Exec(ctx, query, turnID, chatID, parentID, role, status, createdAt, createdAt)
	return err
}

func (s *LLMSeeder) insertContentBlock(ctx context.Context, turnID string, sequence int, blockType, textContent, refType string, createdAt time.Time) error {
	query := `INSERT INTO ` + s.tables.ContentBlocks + ` (turn_id, block_type, sequence, text_content, ref_type, created_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6)`
	_, err := s.pool.Exec(ctx, query, turnID, blockType, sequence, textContent, refType, createdAt)
	return err
}

func (s *LLMSeeder) insertAssistantResponse(ctx context.Context, turnID, thinking, response string, tokenCount int, model string, createdAt time.Time) error {
	query := `INSERT INTO ` + s.tables.AssistantResponses + ` (turn_id, thinking, response, token_count, model, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (turn_id) DO NOTHING`
	_, err := s.pool.Exec(ctx, query, turnID, thinking, response, tokenCount, model, createdAt, createdAt)
	return err
}
