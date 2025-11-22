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

// DocViewFormatter formats doc_view tool results by removing
// unnecessary metadata fields.
// Removes: id, updated_at, word_count (for both documents and folder contents).
type DocViewFormatter struct{}

// Format filters doc_view results to remove metadata fields.
func (f *DocViewFormatter) Format(result interface{}) interface{} {
	resultMap, ok := result.(map[string]interface{})
	if !ok {
		return result // Pass through if not expected format
	}

	filtered := make(map[string]interface{})
	for key, value := range resultMap {
		// Skip filtered fields
		if key == "id" || key == "updated_at" || key == "word_count" {
			continue
		}

		// Recursively filter documents array in folder view
		if key == "documents" {
			if docsArray, ok := value.([]interface{}); ok {
				filteredDocs := make([]interface{}, len(docsArray))
				for i, doc := range docsArray {
					if docMap, ok := doc.(map[string]interface{}); ok {
						filteredDoc := make(map[string]interface{})
						for k, v := range docMap {
							if k != "id" && k != "updated_at" && k != "word_count" {
								filteredDoc[k] = v
							}
						}
						filteredDocs[i] = filteredDoc
					} else {
						filteredDocs[i] = doc
					}
				}
				filtered[key] = filteredDocs
				continue
			}
		}

		filtered[key] = value
	}

	return filtered
}

// DocTreeFormatter formats doc_tree tool results by converting the nested
// JSON structure into a readable tree-like text format (like Unix 'tree' command).
// Uses dependency injection for extensibility (Dependency Inversion Principle).
type DocTreeFormatter struct {
	metadataRenderers []MetadataRenderer
	treeRenderer      *TreeRenderer
}

// NewDocTreeFormatter creates a DocTreeFormatter with default configuration.
// Metadata renderers can be easily extended by adding new implementations
// to the slice (Open/Closed Principle).
//
// Extensibility Example:
// To add new metadata (e.g., timestamps), create a new renderer in metadata_renderers.go:
//
//   type TimestampRenderer struct{}
//   func (r *TimestampRenderer) Render(item map[string]interface{}) string {
//       if ts, ok := item["updated_at"].(string); ok {
//           return fmt.Sprintf("(updated %s)", formatTimestamp(ts))
//       }
//       return ""
//   }
//
// Then add it to the slice below:
//
//   metadataRenderers: []MetadataRenderer{
//       &WordCountRenderer{},
//       &TimestampRenderer{}, // <- add here
//   }
//
func NewDocTreeFormatter() *DocTreeFormatter {
	return &DocTreeFormatter{
		metadataRenderers: []MetadataRenderer{
			&WordCountRenderer{}, // Add more metadata renderers here as needed
		},
		treeRenderer: NewTreeRenderer(),
	}
}

// Format converts doc_tree JSON results into a tree-like text format.
// Returns a formatted string instead of nested JSON for better LLM comprehension.
func (f *DocTreeFormatter) Format(result interface{}) interface{} {
	resultMap, ok := result.(map[string]interface{})
	if !ok {
		return result // Pass through if not expected format
	}

	// Get the path for the root label
	path, _ := resultMap["path"].(string)
	if path == "" {
		path = "/"
	}

	// Build flat list of tree nodes
	nodes := []TreeNode{}

	// Add root node
	rootMetadata := "(root)"
	if path != "/" {
		rootMetadata = "" // Non-root paths don't need (root) label
	}
	nodes = append(nodes, TreeNode{
		Name:     path,
		IsFolder: true,
		Depth:    0,
		IsLast:   false,
		Metadata: rootMetadata,
	})

	// Walk the tree structure depth-first
	f.walkTree(resultMap, 1, &nodes)

	// Render as tree and return as string
	return f.treeRenderer.Render(nodes)
}

// walkTree recursively walks the tree structure and builds a flat list of TreeNodes.
// Processes folders first (with recursion), then documents.
func (f *DocTreeFormatter) walkTree(node map[string]interface{}, depth int, nodes *[]TreeNode) {
	folders, _ := node["folders"].([]interface{})
	documents, _ := node["documents"].([]interface{})

	totalChildren := len(folders) + len(documents)
	if totalChildren == 0 {
		return
	}

	currentIndex := 0

	// Process folders first (depth-first traversal)
	for _, folder := range folders {
		folderMap, ok := folder.(map[string]interface{})
		if !ok {
			continue
		}

		name, _ := folderMap["name"].(string)
		isLast := currentIndex == totalChildren-1

		*nodes = append(*nodes, TreeNode{
			Name:     name,
			IsFolder: true,
			Depth:    depth,
			IsLast:   isLast,
			Metadata: "",
		})

		currentIndex++

		// Recurse into folder (depth-first)
		f.walkTree(folderMap, depth+1, nodes)
	}

	// Then process documents
	for _, doc := range documents {
		docMap, ok := doc.(map[string]interface{})
		if !ok {
			continue
		}

		name, _ := docMap["name"].(string)
		metadata := CombineMetadata(f.metadataRenderers, docMap)
		isLast := currentIndex == totalChildren-1

		*nodes = append(*nodes, TreeNode{
			Name:     name,
			IsFolder: false,
			Depth:    depth,
			IsLast:   isLast,
			Metadata: metadata,
		})

		currentIndex++
	}
}
