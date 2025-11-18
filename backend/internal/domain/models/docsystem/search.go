package docsystem

import (
	"fmt"
)

// SearchStrategy defines the type of search algorithm to use
type SearchStrategy string

const (
	// SearchStrategyFullText uses PostgreSQL full-text search with ts_rank scoring
	SearchStrategyFullText SearchStrategy = "fulltext"

	// SearchStrategyVector uses pgvector for semantic similarity search (FUTURE)
	// Requires: pgvector extension, embedding column, vector indexes
	SearchStrategyVector SearchStrategy = "vector"

	// SearchStrategyHybrid combines FTS + vector search with reranking (FUTURE)
	// Uses Reciprocal Rank Fusion (RRF) or similar merging algorithm
	SearchStrategyHybrid SearchStrategy = "hybrid"
)

// SearchField defines which document fields to search
type SearchField string

const (
	// SearchFieldName searches the document name/title
	// Matches are weighted 2x higher than content matches
	SearchFieldName SearchField = "name"

	// SearchFieldContent searches the document markdown content
	SearchFieldContent SearchField = "content"
)

// Default search configuration values
const (
	DefaultSearchLimit    = 20
	DefaultSearchOffset   = 0
	DefaultSearchLanguage = "english"
	DefaultSearchStrategy = SearchStrategyFullText
)

// SearchOptions configures how documents are searched
// Designed to support multiple search strategies without breaking changes
type SearchOptions struct {
	// Query is the search string (required)
	Query string

	// ProjectID optionally limits search to documents in this project
	// Empty string = search all documents user has access to (all projects)
	ProjectID string

	// Fields specifies which document fields to search
	// Default: [SearchFieldName, SearchFieldContent]
	// Supported: name, content
	// Note: Path search not supported (AI should use get_tree tool, frontend filters client-side)
	Fields []SearchField

	// Pagination
	Limit  int // Number of results to return (default: 20)
	Offset int // Number of results to skip (default: 0)

	// Language specifies the text search configuration for FTS
	// Used for stemming and stop words (e.g., "english", "spanish", "french")
	// See: https://www.postgresql.org/docs/current/textsearch-controls.html
	// Default: "english"
	Language string

	// Strategy selects which search algorithm to use
	// Default: SearchStrategyFullText
	// Currently only fulltext is implemented
	Strategy SearchStrategy

	// FolderID optionally filters results to documents in a specific folder
	// nil = search all folders in the project
	FolderID *string

	// Future fields for vector/hybrid search:
	// MinScore    float64  // Minimum relevance score threshold
	// RerankTop   int      // Number of top results to rerank
	// EmbedModel  string   // Which embedding model to use
}

// ApplyDefaults fills in default values for unset fields
func (opts *SearchOptions) ApplyDefaults() {
	if len(opts.Fields) == 0 {
		opts.Fields = []SearchField{SearchFieldName, SearchFieldContent}
	}
	if opts.Limit <= 0 {
		opts.Limit = DefaultSearchLimit
	}
	if opts.Offset < 0 {
		opts.Offset = DefaultSearchOffset
	}
	if opts.Language == "" {
		opts.Language = DefaultSearchLanguage
	}
	if opts.Strategy == "" {
		opts.Strategy = DefaultSearchStrategy
	}
}

// Validate checks that required fields are set and values are reasonable
func (opts *SearchOptions) Validate() error {
	if opts.Query == "" {
		return fmt.Errorf("search query cannot be empty")
	}
	if opts.Limit < 0 {
		return fmt.Errorf("limit cannot be negative")
	}
	if opts.Limit > 100 {
		return fmt.Errorf("limit cannot exceed 100 (requested: %d)", opts.Limit)
	}
	if opts.Offset < 0 {
		return fmt.Errorf("offset cannot be negative")
	}

	// Validate fields (must be name and/or content)
	for _, field := range opts.Fields {
		switch field {
		case SearchFieldName, SearchFieldContent:
			// Valid fields
		default:
			return fmt.Errorf("invalid search field: %q (supported: name, content)", field)
		}
	}

	// Validate strategy is supported
	switch opts.Strategy {
	case SearchStrategyFullText, "": // empty is ok (will use default)
		// Supported
	case SearchStrategyVector, SearchStrategyHybrid:
		return fmt.Errorf("search strategy %q is not yet implemented", opts.Strategy)
	default:
		return fmt.Errorf("unknown search strategy: %q", opts.Strategy)
	}

	return nil
}

// SearchResult represents a single search result with relevance scoring
type SearchResult struct {
	// Document is the matched document with full content
	Document Document

	// Score represents relevance (higher = better match)
	// - For FTS: ts_rank score (typically 0.0 to 1.0, but can be higher)
	// - For Vector: cosine similarity (0.0 to 1.0)
	// - For Hybrid: normalized combined score (0.0 to 1.0)
	Score float64

	// Metadata contains strategy-specific information
	// Examples:
	// - FTS: {"rank_method": "ts_rank", "language": "english"}
	// - Vector: {"model": "text-embedding-ada-002", "similarity": "cosine"}
	// - Hybrid: {"fts_score": 0.8, "vector_score": 0.6, "rrf_score": 0.7}
	Metadata map[string]interface{}
}

// SearchResults contains the full search response with pagination metadata
type SearchResults struct {
	// Results is the list of matching documents with scores
	Results []SearchResult

	// TotalCount is the total number of matches (regardless of limit/offset)
	// Used for pagination UI (e.g., "Showing 1-20 of 150 results")
	TotalCount int

	// HasMore indicates if there are more results beyond this page
	// Equivalent to: (Offset + len(Results)) < TotalCount
	HasMore bool

	// Offset is the number of results skipped (from SearchOptions)
	Offset int

	// Limit is the maximum number of results requested (from SearchOptions)
	Limit int

	// Strategy indicates which search algorithm was used
	Strategy SearchStrategy
}

// NewSearchResults creates a SearchResults with calculated HasMore flag
func NewSearchResults(results []SearchResult, totalCount int, opts *SearchOptions) *SearchResults {
	hasMore := (opts.Offset + len(results)) < totalCount

	return &SearchResults{
		Results:    results,
		TotalCount: totalCount,
		HasMore:    hasMore,
		Offset:     opts.Offset,
		Limit:      opts.Limit,
		Strategy:   opts.Strategy,
	}
}
