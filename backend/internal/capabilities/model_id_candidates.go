package capabilities

import (
	"regexp"
	"strings"
)

var (
	// openRouterVersionSuffixRe matches OpenRouter-style model version suffixes like:
	//   openai/gpt-5-mini-2025-08-07
	// We only strip this for OpenRouter capability matching (not for other providers).
	openRouterVersionSuffixRe = regexp.MustCompile(`-\d{4}-\d{2}-\d{2}$`)
)

// ModelIDCandidates returns ordered model ID candidates for capability lookup.
//
// Why this exists:
//   - Some providers return model variants at runtime (e.g. OpenRouter appends -YYYY-MM-DD,
//     or uses :online suffixes) that are not appropriate as stable capability IDs.
//   - Callers should be able to look up capabilities using either the request model or
//     provider-reported model without breaking interruption/token logic.
//
// Design:
// - Pure function (SRP) with provider-aware rules (OCP: add provider rules here).
// - Returns de-duplicated candidates in priority order (exact match first).
func ModelIDCandidates(provider, model string) []string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}

	var out []string
	seen := make(map[string]struct{}, 4)
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" {
			return
		}
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}

	// 1) Exact
	add(model)

	// Provider-aware normalizations.
	switch provider {
	case "openrouter":
		// 2) Strip :variant suffix (e.g. :online)
		add(stripColonVariant(model))

		// 3) Strip OpenRouter version suffix, both with and without :variant.
		add(stripOpenRouterVersionSuffix(model))
		add(stripOpenRouterVersionSuffix(stripColonVariant(model)))
	}

	return out
}

func stripColonVariant(model string) string {
	if i := strings.IndexByte(model, ':'); i >= 0 {
		return model[:i]
	}
	return model
}

func stripOpenRouterVersionSuffix(model string) string {
	return openRouterVersionSuffixRe.ReplaceAllString(model, "")
}
