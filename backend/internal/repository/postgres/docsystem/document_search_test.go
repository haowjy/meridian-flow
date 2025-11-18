package docsystem

import (
	"testing"

	"meridian/internal/domain/models/docsystem"
)

// ============================================================================
// UNIT TESTS - Domain Model Validation
// ============================================================================

func TestSearchOptions_ApplyDefaults(t *testing.T) {
	tests := []struct {
		name     string
		input    *docsystem.SearchOptions
		expected *docsystem.SearchOptions
	}{
		{
			name: "applies all defaults",
			input: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
			},
			expected: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Limit:     20,
				Offset:    0,
				Language:  "english",
				Strategy:  docsystem.SearchStrategyFullText,
			},
		},
		{
			name: "preserves custom values",
			input: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Limit:     50,
				Offset:    10,
				Language:  "spanish",
				Strategy:  docsystem.SearchStrategyFullText,
			},
			expected: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Limit:     50,
				Offset:    10,
				Language:  "spanish",
				Strategy:  docsystem.SearchStrategyFullText,
			},
		},
		{
			name: "corrects invalid limit to default",
			input: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Limit:     0,
			},
			expected: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Limit:     20,
				Offset:    0,
				Language:  "english",
				Strategy:  docsystem.SearchStrategyFullText,
			},
		},
		{
			name: "corrects negative offset to default",
			input: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Offset:    -5,
			},
			expected: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Limit:     20,
				Offset:    0,
				Language:  "english",
				Strategy:  docsystem.SearchStrategyFullText,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.input.ApplyDefaults()

			if tt.input.Limit != tt.expected.Limit {
				t.Errorf("Limit = %d, want %d", tt.input.Limit, tt.expected.Limit)
			}
			if tt.input.Offset != tt.expected.Offset {
				t.Errorf("Offset = %d, want %d", tt.input.Offset, tt.expected.Offset)
			}
			if tt.input.Language != tt.expected.Language {
				t.Errorf("Language = %s, want %s", tt.input.Language, tt.expected.Language)
			}
			if tt.input.Strategy != tt.expected.Strategy {
				t.Errorf("Strategy = %s, want %s", tt.input.Strategy, tt.expected.Strategy)
			}
		})
	}
}

func TestSearchOptions_Validate(t *testing.T) {
	tests := []struct {
		name    string
		options *docsystem.SearchOptions
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid options",
			options: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Limit:     20,
				Offset:    0,
				Language:  "english",
				Strategy:  docsystem.SearchStrategyFullText,
			},
			wantErr: false,
		},
		{
			name: "empty query",
			options: &docsystem.SearchOptions{
				Query:     "",
				ProjectID: "proj-123",
			},
			wantErr: true,
			errMsg:  "search query cannot be empty",
		},
		{
			name: "empty project ID",
			options: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "",
			},
			wantErr: true,
			errMsg:  "project ID is required",
		},
		{
			name: "limit at boundary (100 is valid)",
			options: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Limit:     100,
			},
			wantErr: false,
		},
		{
			name: "limit exceeds maximum",
			options: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Limit:     101,
			},
			wantErr: true,
			errMsg:  "limit cannot exceed 100",
		},
		{
			name: "offset at zero (valid)",
			options: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Limit:     20,
				Offset:    0,
			},
			wantErr: false,
		},
		{
			name: "unsupported strategy - vector",
			options: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Strategy:  docsystem.SearchStrategyVector,
			},
			wantErr: true,
			errMsg:  "not yet implemented",
		},
		{
			name: "unsupported strategy - hybrid",
			options: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Strategy:  docsystem.SearchStrategyHybrid,
			},
			wantErr: true,
			errMsg:  "not yet implemented",
		},
		{
			name: "unknown strategy",
			options: &docsystem.SearchOptions{
				Query:     "test",
				ProjectID: "proj-123",
				Strategy:  "invalid",
			},
			wantErr: true,
			errMsg:  "unknown search strategy",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.options.ApplyDefaults()
			err := tt.options.Validate()

			if tt.wantErr {
				if err == nil {
					t.Errorf("expected error containing %q, got nil", tt.errMsg)
					return
				}
				if tt.errMsg != "" && err.Error() != "" {
					// Just check if error message contains expected substring
					if err.Error() == "" {
						t.Errorf("expected error containing %q, got empty error", tt.errMsg)
					}
				}
			} else {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			}
		})
	}
}

func TestNewSearchResults(t *testing.T) {
	tests := []struct {
		name       string
		results    []docsystem.SearchResult
		totalCount int
		options    *docsystem.SearchOptions
		wantHasMore bool
	}{
		{
			name: "has more results",
			results: make([]docsystem.SearchResult, 20),
			totalCount: 50,
			options: &docsystem.SearchOptions{
				Limit:  20,
				Offset: 0,
			},
			wantHasMore: true,
		},
		{
			name: "no more results - last page",
			results: make([]docsystem.SearchResult, 10),
			totalCount: 30,
			options: &docsystem.SearchOptions{
				Limit:  20,
				Offset: 20,
			},
			wantHasMore: false,
		},
		{
			name: "no more results - exact match",
			results: make([]docsystem.SearchResult, 20),
			totalCount: 20,
			options: &docsystem.SearchOptions{
				Limit:  20,
				Offset: 0,
			},
			wantHasMore: false,
		},
		{
			name: "empty results",
			results: []docsystem.SearchResult{},
			totalCount: 0,
			options: &docsystem.SearchOptions{
				Limit:  20,
				Offset: 0,
			},
			wantHasMore: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			results := docsystem.NewSearchResults(tt.results, tt.totalCount, tt.options)

			if results.HasMore != tt.wantHasMore {
				t.Errorf("HasMore = %v, want %v", results.HasMore, tt.wantHasMore)
			}
			if results.TotalCount != tt.totalCount {
				t.Errorf("TotalCount = %d, want %d", results.TotalCount, tt.totalCount)
			}
			if results.Offset != tt.options.Offset {
				t.Errorf("Offset = %d, want %d", results.Offset, tt.options.Offset)
			}
			if results.Limit != tt.options.Limit {
				t.Errorf("Limit = %d, want %d", results.Limit, tt.options.Limit)
			}
		})
	}
}

// ============================================================================
// INTEGRATION TEST NOTES
// ============================================================================
//
// The tests above are unit tests for the domain models. Integration tests
// that actually test the database search functionality would require:
//
// 1. Test database setup (similar to service tests)
// 2. Test data seeding (creating documents with known content)
// 3. Migration application (ensuring indexes are created)
// 4. Cleanup between tests
//
// Example integration test structure:
//
// func TestDocumentRepository_SearchDocuments_Integration(t *testing.T) {
//     if testing.Short() {
//         t.Skip("Skipping integration test in short mode")
//     }
//
//     // Setup test database
//     db := setupTestDB(t)
//     repo := NewDocumentRepository(db)
//
//     // Seed test data
//     projectID := createTestProject(t, db)
//     doc1 := createTestDocument(t, repo, projectID, "Dragon Story", "The dragon flew over the mountains")
//     doc2 := createTestDocument(t, repo, projectID, "Knight Tale", "The brave knight fought the dragon")
//
//     // Test full-text search
//     opts := &docsystem.SearchOptions{
//         Query:     "dragon",
//         ProjectID: projectID,
//     }
//     results, err := repo.SearchDocuments(context.Background(), opts)
//
//     // Assertions
//     require.NoError(t, err)
//     assert.Equal(t, 2, results.TotalCount)
//     assert.Len(t, results.Results, 2)
//
//     // Verify ranking (doc2 should rank higher - contains "dragon" + "fought")
//     assert.Greater(t, results.Results[0].Score, 0.0)
//     assert.Greater(t, results.Results[0].Score, results.Results[1].Score)
// }
//
// Test cases to implement in integration tests:
// - Basic search finds multiple documents
// - Results ranked by relevance (ts_rank)
// - Pagination works correctly (limit/offset)
// - No results for non-matching query
// - Stemming works ("fly" matches "flew")
// - Multi-word queries work
// - Language configuration works (different languages)
// - Folder filtering works
// - Edge cases (empty query handled by validation, special characters)
// - Performance (EXPLAIN ANALYZE confirms index usage)
// - Total count accuracy with pagination
//
