package formatting

import (
	"strings"
)

// TreeNode represents a single node in the tree structure.
type TreeNode struct {
	Name     string
	IsFolder bool
	Depth    int
	IsLast   bool   // Is this the last child of its parent?
	Metadata string // Pre-rendered metadata (e.g., "(277 words)")
}

// TreeRenderer renders a hierarchical tree structure using ASCII box-drawing characters.
// It follows the Single Responsibility Principle by only handling tree structure rendering.
type TreeRenderer struct{}

// NewTreeRenderer creates a new TreeRenderer instance.
func NewTreeRenderer() *TreeRenderer {
	return &TreeRenderer{}
}

// Render converts a list of TreeNodes into a formatted tree string.
// Each node should have correct depth and IsLast flag set.
//
// Example output:
//   / (root)
//   ├── file1.md (100 words)
//   ├── folder/
//   │   └── file2.md (200 words)
//   └── file3.md (150 words)
func (r *TreeRenderer) Render(nodes []TreeNode) string {
	if len(nodes) == 0 {
		return ""
	}

	var result strings.Builder

	// Track which depths still have siblings below (for continuation lines)
	continuations := make(map[int]bool)

	for i, node := range nodes {
		// Build the prefix for this line
		prefix := r.buildPrefix(node.Depth, node.IsLast, continuations)

		// Build the line
		line := prefix + node.Name

		// Add folder indicator (unless name already ends with /, e.g., root "/")
		if node.IsFolder && !strings.HasSuffix(node.Name, "/") {
			line += "/"
		}

		// Add metadata
		if node.Metadata != "" {
			line += " " + node.Metadata
		}

		result.WriteString(line)

		// Add newline unless it's the last node
		if i < len(nodes)-1 {
			result.WriteString("\n")
		}

		// Update continuations for next iteration
		if node.IsLast {
			delete(continuations, node.Depth)
		} else {
			continuations[node.Depth] = true
		}
	}

	return result.String()
}

// buildPrefix creates the tree structure prefix for a node based on its depth and position.
func (r *TreeRenderer) buildPrefix(depth int, isLast bool, continuations map[int]bool) string {
	if depth == 0 {
		return ""
	}

	var prefix strings.Builder

	// Add continuation lines for parent depths
	for d := 0; d < depth-1; d++ {
		if continuations[d] {
			prefix.WriteString("│   ")
		} else {
			prefix.WriteString("    ")
		}
	}

	// Add the branch for this node
	if isLast {
		prefix.WriteString("└── ")
	} else {
		prefix.WriteString("├── ")
	}

	return prefix.String()
}
