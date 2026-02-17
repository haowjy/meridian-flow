package collab

import (
	"database/sql"
	"testing"
)

func TestParseJSONBoolString(t *testing.T) {
	tests := []struct {
		name  string
		value sql.NullString
		want  *bool
	}{
		{
			name:  "null",
			value: sql.NullString{Valid: false},
			want:  nil,
		},
		{
			name:  "true",
			value: sql.NullString{String: "true", Valid: true},
			want:  boolPtr(true),
		},
		{
			name:  "false",
			value: sql.NullString{String: "false", Valid: true},
			want:  boolPtr(false),
		},
		{
			name:  "invalid",
			value: sql.NullString{String: "not-a-bool", Valid: true},
			want:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseJSONBoolString(tt.value)
			if tt.want == nil {
				if got != nil {
					t.Fatalf("expected nil, got %v", *got)
				}
				return
			}

			if got == nil {
				t.Fatal("expected bool pointer, got nil")
			}
			if *got != *tt.want {
				t.Fatalf("expected %v, got %v", *tt.want, *got)
			}
		})
	}
}

func boolPtr(v bool) *bool {
	return &v
}
