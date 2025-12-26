package external

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	// DefaultTavilyBaseURL is the default Tavily API endpoint
	DefaultTavilyBaseURL = "https://api.tavily.com/search"
	// DefaultTavilyTimeout is the default HTTP timeout for Tavily requests
	DefaultTavilyTimeout = 30 * time.Second
)

// TavilyClient implements SearchClient for Tavily AI.
type TavilyClient struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
}

// NewTavilyClient creates a new Tavily search client.
func NewTavilyClient(apiKey string) *TavilyClient {
	return &TavilyClient{
		apiKey:  apiKey,
		baseURL: DefaultTavilyBaseURL,
		httpClient: &http.Client{
			Timeout: DefaultTavilyTimeout,
		},
	}
}

// NewTavilyClientWithConfig creates a Tavily client with custom configuration.
func NewTavilyClientWithConfig(apiKey string, baseURL string, timeout time.Duration) *TavilyClient {
	return &TavilyClient{
		apiKey:  apiKey,
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// Search implements SearchClient interface for Tavily.
func (c *TavilyClient) Search(ctx context.Context, query string, opts SearchOptions) (*SearchResponse, error) {
	// Apply defaults
	if opts.MaxResults == 0 {
		opts.MaxResults = 5
	}
	if opts.MaxResults > 20 {
		opts.MaxResults = 20 // Tavily max is typically 20
	}

	// Build request payload
	// Note: Tavily expects API key in the body, not in headers
	payload := map[string]interface{}{
		"api_key":     c.apiKey,
		"query":       query,
		"max_results": opts.MaxResults,
	}

	// Add optional search type if specified
	if opts.SearchType != "" {
		payload["search_depth"] = opts.SearchType // Tavily uses "basic" or "advanced"
	}

	// Add optional topic if specified
	if opts.Topic != "" {
		payload["topic"] = opts.Topic // Tavily uses "general", "news", or "finance"
	}

	// Marshal payload
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create HTTP request
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL, bytes.NewReader(payloadBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() // Error ignored: response consumed

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	// Check HTTP status
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	// Parse response
	var tavilyResp tavilyResponse
	if err := json.Unmarshal(body, &tavilyResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	// Convert to common format
	results := make([]SearchResult, len(tavilyResp.Results))
	for i, r := range tavilyResp.Results {
		results[i] = SearchResult{
			Title:   r.Title,
			URL:     r.URL,
			Snippet: r.Content,
			Score:   r.Score,
		}

		// Parse published date if available
		if r.PublishedDate != "" {
			if t, err := time.Parse(time.RFC3339, r.PublishedDate); err == nil {
				results[i].PublishedAt = &t
			}
		}
	}

	return &SearchResponse{
		Results:   results,
		Query:     query,
		Timestamp: time.Now(),
	}, nil
}

// tavilyResponse represents the response from Tavily API
type tavilyResponse struct {
	Results []tavilyResult `json:"results"`
	Query   string         `json:"query"`
}

// tavilyResult represents a single search result from Tavily
type tavilyResult struct {
	Title         string  `json:"title"`
	URL           string  `json:"url"`
	Content       string  `json:"content"`
	Score         float64 `json:"score"`
	PublishedDate string  `json:"published_date,omitempty"`
}
