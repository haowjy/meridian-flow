package tools

import (
	"strings"
	"testing"
)

func TestTryMatchWithNormalizers_LineNumbers(t *testing.T) {
	base := "Characters/Aria.md\nWorld Building/Geography.md"
	oldStr := "1: Characters/Aria.md\n2: World Building/Geography.md"
	newStr := "1: Characters/Shadow.md\n2: World Building/History.md"

	result, errMsg := tryMatchWithNormalizers(base, oldStr, newStr, DefaultNormalizers())
	if errMsg != "" {
		t.Fatalf("expected no error message, got %q", errMsg)
	}
	if result == nil {
		t.Fatal("expected match result, got nil")
	}
	if result.matchedOld != base {
		t.Fatalf("matchedOld=%q, want %q", result.matchedOld, base)
	}
	if result.normalizedNew != "Characters/Shadow.md\nWorld Building/History.md" {
		t.Fatalf("normalizedNew=%q", result.normalizedNew)
	}
	if result.appliedNorm != "line_numbers" {
		t.Fatalf("appliedNorm=%q, want line_numbers", result.appliedNorm)
	}
}

func TestTryMatchWithNormalizers_LineEndings(t *testing.T) {
	base := "line1\nline2\nline3"
	oldStr := "line1\r\nline2\r\nline3"
	newStr := "updated1\r\nupdated2\r\nupdated3"

	result, errMsg := tryMatchWithNormalizers(base, oldStr, newStr, DefaultNormalizers())
	if errMsg != "" {
		t.Fatalf("expected no error message, got %q", errMsg)
	}
	if result == nil {
		t.Fatal("expected match result, got nil")
	}
	if result.matchedOld != base {
		t.Fatalf("matchedOld=%q, want %q", result.matchedOld, base)
	}
	if result.normalizedNew != "updated1\nupdated2\nupdated3" {
		t.Fatalf("normalizedNew=%q", result.normalizedNew)
	}
	if result.appliedNorm != "line_endings" {
		t.Fatalf("appliedNorm=%q, want line_endings", result.appliedNorm)
	}
}

func TestTryMatchWithNormalizers_TrailingWhitespace(t *testing.T) {
	base := "alpha\nbeta"
	oldStr := "alpha  \nbeta\t\n"
	newStr := "gamma \ndelta\t\n"

	result, errMsg := tryMatchWithNormalizers(base, oldStr, newStr, DefaultNormalizers())
	if errMsg != "" {
		t.Fatalf("expected no error message, got %q", errMsg)
	}
	if result == nil {
		t.Fatal("expected match result, got nil")
	}
	if result.matchedOld != base {
		t.Fatalf("matchedOld=%q, want %q", result.matchedOld, base)
	}
	if result.normalizedNew != "gamma\ndelta" {
		t.Fatalf("normalizedNew=%q", result.normalizedNew)
	}
	if result.appliedNorm != "trailing_whitespace" {
		t.Fatalf("appliedNorm=%q, want trailing_whitespace", result.appliedNorm)
	}
}

func TestTryMatchWithNormalizers_CumulativeChain(t *testing.T) {
	base := "qwef qw\nef qwef\n qwef\nqwef q"
	oldStr := "52: qwef qw  \r\n53: ef qwef\t\r\n54:  qwef \r\n55: qwef q\r\n"
	newStr := "52: cleaned one \r\n53: cleaned two\t\r\n54: cleaned three\r\n55: cleaned four\r\n"

	result, errMsg := tryMatchWithNormalizers(base, oldStr, newStr, DefaultNormalizers())
	if errMsg != "" {
		t.Fatalf("expected no error message, got %q", errMsg)
	}
	if result == nil {
		t.Fatal("expected match result, got nil")
	}
	if result.matchedOld != base {
		t.Fatalf("matchedOld=%q, want %q", result.matchedOld, base)
	}
	if result.normalizedNew != "cleaned one\ncleaned two\ncleaned three\ncleaned four" {
		t.Fatalf("normalizedNew=%q", result.normalizedNew)
	}
	if result.appliedNorm != "chain(line_numbers->line_endings->trailing_whitespace)" {
		t.Fatalf("appliedNorm=%q", result.appliedNorm)
	}
}

func TestTryMatchWithNormalizers_FlexWhitespace(t *testing.T) {
	base := "first\n  qwef qw\n\tef qwef\n qwef\nqwef q\nlast"
	oldStr := "20: qwef qw\n21: ef qwef\n22: qwef\n23: qwef q\n"
	newStr := "20: cleaned a\n21: cleaned b\n22: cleaned c\n23: cleaned d\n"

	result, errMsg := tryMatchWithNormalizers(base, oldStr, newStr, DefaultNormalizers())
	if errMsg != "" {
		t.Fatalf("expected no error message, got %q", errMsg)
	}
	if result == nil {
		t.Fatal("expected match result, got nil")
	}
	if result.appliedNorm != "flex_whitespace" {
		t.Fatalf("appliedNorm=%q, want flex_whitespace", result.appliedNorm)
	}
	if result.matchedOld != "  qwef qw\n\tef qwef\n qwef\nqwef q" {
		t.Fatalf("matchedOld=%q", result.matchedOld)
	}
	if result.normalizedNew != "cleaned a\ncleaned b\ncleaned c\ncleaned d" {
		t.Fatalf("normalizedNew=%q", result.normalizedNew)
	}
}

func TestTryMatchWithNormalizers_FlexWhitespaceAmbiguous(t *testing.T) {
	base := "  x\n  y\n\n  x\n  y\n"
	oldStr := "1: x\n2: y\n"
	newStr := "1: z\n2: w\n"

	result, errMsg := tryMatchWithNormalizers(base, oldStr, newStr, DefaultNormalizers())
	if result != nil {
		t.Fatal("expected nil result for ambiguous match")
	}
	if errMsg == "" {
		t.Fatal("expected ambiguity error message")
	}
	if !strings.HasPrefix(errMsg, "AMBIGUOUS_MATCH:") {
		t.Fatalf("expected AMBIGUOUS_MATCH prefix, got %q", errMsg)
	}
}
