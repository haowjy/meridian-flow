package main

import "testing"

func TestValidStage(t *testing.T) {
	for _, name := range StageOrder {
		if !ValidStage(name) {
			t.Errorf("ValidStage(%q) = false, want true", name)
		}
	}

	if ValidStage("bogus") {
		t.Error("ValidStage(\"bogus\") = true, want false")
	}
}

func TestStageIndex(t *testing.T) {
	tests := []struct {
		name     string
		expected int
	}{
		{"plan", 0},
		{"implement", 1},
		{"review", 2},
		{"cleanup", 3},
		{"commit", 4},
		{"bogus", -1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := StageIndex(tt.name)
			if got != tt.expected {
				t.Errorf("StageIndex(%q) = %d, want %d", tt.name, got, tt.expected)
			}
		})
	}
}

func TestAllStagesHaveConfig(t *testing.T) {
	for _, name := range StageOrder {
		stage, ok := Stages[name]
		if !ok {
			t.Fatalf("stage %q in StageOrder but not in Stages map", name)
		}
		if stage.Template == "" {
			t.Errorf("stage %q has empty Template", name)
		}
		if stage.Tools == "" {
			t.Errorf("stage %q has empty Tools", name)
		}
		if stage.MaxTurns == 0 {
			t.Errorf("stage %q has zero MaxTurns", name)
		}
	}
}
