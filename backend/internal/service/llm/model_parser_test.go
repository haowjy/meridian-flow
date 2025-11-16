package llm

import (
	"testing"
)

func TestParseModel(t *testing.T) {
	tests := []struct {
		name          string
		modelStr      string
		wantProvider  string
		wantModel     string
		wantErr       bool
	}{
		{
			name:         "claude-haiku with version",
			modelStr:     "claude-haiku-4-5",
			wantProvider: "anthropic",
			wantModel:    "claude-haiku-4-5",
			wantErr:      false,
		},
		{
			name:         "claude-sonnet with full version",
			modelStr:     "claude-sonnet-4-5-20251001",
			wantProvider: "anthropic",
			wantModel:    "claude-sonnet-4-5-20251001",
			wantErr:      false,
		},
		{
			name:         "openrouter with full path",
			modelStr:     "openrouter/anthropic/claude-haiku-4-5",
			wantProvider: "openrouter",
			wantModel:    "anthropic/claude-haiku-4-5",
			wantErr:      false,
		},
		{
			name:         "bedrock with claude",
			modelStr:     "bedrock/claude-haiku-4-5",
			wantProvider: "bedrock",
			wantModel:    "claude-haiku-4-5",
			wantErr:      false,
		},
		{
			name:         "gpt-4 model",
			modelStr:     "gpt-4",
			wantProvider: "openai",
			wantModel:    "gpt-4",
			wantErr:      false,
		},
		{
			name:         "gemini model",
			modelStr:     "gemini-pro",
			wantProvider: "gemini",
			wantModel:    "gemini-pro",
			wantErr:      false,
		},
		{
			name:         "lorem-fast model",
			modelStr:     "lorem-fast",
			wantProvider: "lorem",
			wantModel:    "lorem-fast",
			wantErr:      false,
		},
		{
			name:         "lorem-slow model",
			modelStr:     "lorem-slow",
			wantProvider: "lorem",
			wantModel:    "lorem-slow",
			wantErr:      false,
		},
		{
			name:     "empty string",
			modelStr: "",
			wantErr:  true,
		},
		{
			name:     "unknown model prefix",
			modelStr: "unknown-model-123",
			wantErr:  true,
		},
		{
			name:     "provider without model",
			modelStr: "anthropic/",
			wantErr:  true,
		},
		{
			name:     "model without provider",
			modelStr: "/claude-haiku-4-5",
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseModel(tt.modelStr)

			if tt.wantErr {
				if err == nil {
					t.Errorf("ParseModel() expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Errorf("ParseModel() unexpected error: %v", err)
				return
			}

			if got.Provider != tt.wantProvider {
				t.Errorf("ParseModel() provider = %v, want %v", got.Provider, tt.wantProvider)
			}

			if got.Model != tt.wantModel {
				t.Errorf("ParseModel() model = %v, want %v", got.Model, tt.wantModel)
			}
		})
	}
}

func TestInferProvider(t *testing.T) {
	tests := []struct {
		name         string
		model        string
		wantProvider string
	}{
		{"claude lowercase", "claude-haiku-4-5", "anthropic"},
		{"CLAUDE uppercase", "CLAUDE-HAIKU-4-5", "anthropic"},
		{"gpt lowercase", "gpt-4", "openai"},
		{"GPT uppercase", "GPT-4", "openai"},
		{"o1 model", "o1-preview", "openai"},
		{"gemini model", "gemini-pro", "gemini"},
		{"lorem-fast model", "lorem-fast", "lorem"},
		{"lorem-slow model", "lorem-slow", "lorem"},
		{"LOREM uppercase", "LOREM-FAST", "lorem"},
		{"unknown", "unknown-123", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := inferProvider(tt.model)
			if got != tt.wantProvider {
				t.Errorf("inferProvider() = %v, want %v", got, tt.wantProvider)
			}
		})
	}
}
