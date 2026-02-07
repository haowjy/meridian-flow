package formatting

// DocSearchFormatter formats doc_search tool results by filtering
// unnecessary fields to reduce token usage and improve readability.
// Keeps: name, path, preview per result; total_count, has_more for pagination.
// Removes: id, score, updated_at, word_count per result.
type DocSearchFormatter struct{}

// Format filters doc_search results to essential fields only.
func (f *DocSearchFormatter) Format(result interface{}) interface{} {
	resultMap, ok := result.(map[string]interface{})
	if !ok {
		return result // Pass through if not expected format
	}

	// Process results array
	resultsRaw, ok := resultMap["results"]
	if !ok {
		return result
	}

	resultsArray, ok := resultsRaw.([]interface{})
	if !ok {
		return result
	}

	// Filter each result to keep only essential fields
	filtered := make([]interface{}, len(resultsArray))
	for i, item := range resultsArray {
		if itemMap, ok := item.(map[string]interface{}); ok {
			filtered[i] = map[string]interface{}{
				"name":    itemMap["name"],
				"path":    itemMap["path"],
				"preview": itemMap["preview"],
			}
		} else {
			filtered[i] = item // Keep original if not a map
		}
	}

	// Return filtered results with pagination metadata for LLM decision-making
	return map[string]interface{}{
		"results":     filtered,
		"total_count": resultMap["total_count"],
		"has_more":    resultMap["has_more"],
	}
}
