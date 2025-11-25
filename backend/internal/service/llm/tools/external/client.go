package external

import (
	"context"
	"time"
)

// SearchClient defines the interface for external search APIs.
// Implementations include Tavily, Brave, Serper, etc.
type SearchClient interface {
	// Search performs a web search and returns results.
	Search(ctx context.Context, query string, opts SearchOptions) (*SearchResponse, error)
}

// SearchOptions configures search behavior.
type SearchOptions struct {
	MaxResults int    // Maximum number of results to return
	SearchType string // "general", "news", "academic", etc. (provider-specific)
	Topic      string // Search category: "general", "news", "finance" (Tavily-specific)
}

// SearchResponse contains search results from external API.
type SearchResponse struct {
	Results   []SearchResult
	Query     string
	Timestamp time.Time
}

// SearchResult represents a single search result.
type SearchResult struct {
	Title       string    // Page title
	URL         string    // Page URL
	Snippet     string    // Content snippet/description
	PublishedAt *time.Time // Publication date (if available)
	Score       float64    // Relevance score (if available)
}
