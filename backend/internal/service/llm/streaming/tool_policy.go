package streaming

import (
	"fmt"

	"meridian/internal/domain/models/docsystem"
)

// serverDefaultToolOrder is the canonical tool set for a normal user thread.
// The client must not be treated as the source of truth for tool availability.
//
// NOTE: Web search routing uses the *requested* tool name "tavily_web_search" while
// the actual function name exposed to providers is "web_search".
var serverDefaultToolOrder = []string{
	"doc_view",
	"doc_search",
	"doc_tree",
	"doc_edit",
}

func parseDisabledTools(preferences docsystem.JSONMap) map[string]bool {
	disabled := make(map[string]bool)
	if preferences == nil {
		return disabled
	}

	raw, ok := preferences["disabled_tools"]
	if !ok || raw == nil {
		return disabled
	}

	switch v := raw.(type) {
	case []string:
		for _, name := range v {
			if name == "" {
				continue
			}
			disabled[name] = true
		}
		return disabled
	case []interface{}:
		for _, item := range v {
			s, ok := item.(string)
			if !ok || s == "" {
				continue
			}
			disabled[s] = true
		}
		return disabled
	default:
		// Unexpected shape; fail closed by treating as "no disabled tools" but
		// keep it visible in logs upstream.
		return disabled
	}
}

func resolveServerToolNames(includeWebSearch bool, disabled map[string]bool) []string {
	out := make([]string, 0, len(serverDefaultToolOrder)+1)
	for _, name := range serverDefaultToolOrder {
		if disabled[name] {
			continue
		}
		out = append(out, name)
	}

	if includeWebSearch && !disabled["tavily_web_search"] {
		out = append(out, "tavily_web_search")
	}

	return out
}

func toolNamesToRequestParamsTools(toolNames []string) ([]interface{}, error) {
	tools := make([]interface{}, 0, len(toolNames))
	for _, name := range toolNames {
		if name == "" {
			continue
		}
		tools = append(tools, map[string]interface{}{
			"name": name, // minimal format; expanded later by GetRequestParamStruct
		})
	}

	// Always return a slice (not nil) for deterministic JSON output and easier debugging.
	if tools == nil {
		return []interface{}{}, nil
	}

	// Extra defense: ensure it's JSON-marshalable. (This should always be true.)
	// We keep this lightweight because request_params is ultimately JSONB.
	for _, t := range tools {
		if _, ok := t.(map[string]interface{}); !ok {
			return nil, fmt.Errorf("unexpected tool element type: %T", t)
		}
	}

	return tools, nil
}
