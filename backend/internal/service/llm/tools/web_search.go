package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"meridian/internal/service/llm/tools/external"
)

// WebSearchTool implements the 'web_search' tool for searching the web via external APIs.
// Uses the SearchClient abstraction to support multiple providers (Tavily, Brave, Serper, etc.).
type WebSearchTool struct {
	client external.SearchClient
	config *ToolConfig
}

// NewWebSearchTool creates a new WebSearchTool instance.
func NewWebSearchTool(
	client external.SearchClient,
	config *ToolConfig,
) *WebSearchTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &WebSearchTool{
		client: client,
		config: config,
	}
}

// Execute implements ToolExecutor interface.
// Input parameters:
//   - query (string, required): Search query
//   - max_results (integer, optional): Maximum results to return (default: 5, max: 10)
//   - topic (string, optional): Search category - "general", "news", or "finance" (default: "general")
//
// Returns:
//   - {results: [...], query: string, result_count: int}
func (t *WebSearchTool) Execute(ctx context.Context, input map[string]interface{}) (interface{}, error) {
	// Validate and extract query
	query, ok := input["query"].(string)
	if !ok || strings.TrimSpace(query) == "" {
		return nil, errors.New("missing required parameter: query (string)")
	}

	query = strings.TrimSpace(query)

	// Extract optional max_results parameter
	maxResults := t.config.WebSearchDefaultLimit
	if maxVal, exists := input["max_results"]; exists {
		if maxFloat, ok := maxVal.(float64); ok {
			maxResults = int(maxFloat)
			if maxResults < 1 {
				maxResults = 1
			} else if maxResults > t.config.WebSearchMaxLimit {
				maxResults = t.config.WebSearchMaxLimit
			}
		}
	}

	// Extract optional topic parameter
	topic := ""
	if topicVal, exists := input["topic"]; exists {
		if topicStr, ok := topicVal.(string); ok {
			topic = strings.TrimSpace(topicStr)
			// Validate topic is one of the allowed values
			if topic != "" && topic != "general" && topic != "news" && topic != "finance" {
				return nil, fmt.Errorf("invalid topic '%s': must be 'general', 'news', or 'finance'", topic)
			}
		}
	}

	// Execute search via external client
	searchOpts := external.SearchOptions{
		MaxResults: maxResults,
		Topic:      topic,
	}

	response, err := t.client.Search(ctx, query, searchOpts)
	if err != nil {
		return nil, fmt.Errorf("web search failed: %w", err)
	}

	// Format results for LLM consumption
	resultList := make([]map[string]interface{}, len(response.Results))
	for i, result := range response.Results {
		resultMap := map[string]interface{}{
			"title":   result.Title,
			"url":     result.URL,
			"snippet": result.Snippet,
		}

		// Add optional fields if available
		if result.PublishedAt != nil {
			resultMap["published_at"] = result.PublishedAt.Format("2006-01-02")
		}
		if result.Score > 0 {
			resultMap["score"] = result.Score
		}

		resultList[i] = resultMap
	}

	return map[string]interface{}{
		"results":      resultList,
		"query":        query,
		"result_count": len(resultList),
	}, nil
}
