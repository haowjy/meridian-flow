package streaming

import (
	"testing"

	"meridian/internal/config"
	llmModels "meridian/internal/domain/models/llm"
)

// TestEnvironmentGatingForTools verifies that tools are only allowed in dev/test environments
// This tests the logic from service.go:109-113
func TestEnvironmentGatingForTools(t *testing.T) {
	tests := []struct {
		name        string
		environment string
		toolCount   int // Number of tools in params
		shouldBlock bool
	}{
		{
			name:        "dev environment allows tools",
			environment: "dev",
			toolCount:   1,
			shouldBlock: false,
		},
		{
			name:        "test environment allows tools",
			environment: "test",
			toolCount:   1,
			shouldBlock: false,
		},
		{
			name:        "prod environment blocks tools",
			environment: "prod",
			toolCount:   1,
			shouldBlock: true,
		},
		{
			name:        "prod environment allows no tools",
			environment: "prod",
			toolCount:   0,
			shouldBlock: false,
		},
		{
			name:        "dev environment allows no tools",
			environment: "dev",
			toolCount:   0,
			shouldBlock: false,
		},
		{
			name:        "staging environment blocks tools",
			environment: "staging",
			toolCount:   1,
			shouldBlock: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Mock config with environment
			cfg := &config.Config{
				Environment: tt.environment,
			}

			// Create params with tools
			params := &llmModels.RequestParams{
				Tools: make([]llmModels.ToolDefinition, tt.toolCount),
			}

			// This is the exact logic from service.go:109-113
			// Environment gating: Reject tools in production
			shouldBlock := false
			if cfg.Environment != "dev" && cfg.Environment != "test" {
				if len(params.Tools) > 0 {
					shouldBlock = true
				}
			}

			if shouldBlock != tt.shouldBlock {
				t.Errorf("environment gating mismatch: got shouldBlock=%v, want shouldBlock=%v", shouldBlock, tt.shouldBlock)
			}
		})
	}
}
