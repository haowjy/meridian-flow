package docsystem

import (
	"context"
)

// Namespace represents a virtual namespace for document paths
type Namespace string

const (
	// NamespaceWorkspace is the default space namespace (user's documents)
	NamespaceWorkspace Namespace = ""

	// NamespaceMeridian is the system namespace for Meridian internal files (/.meridian/**)
	NamespaceMeridian Namespace = ".meridian"

	// NamespaceSession is the virtual session namespace for ephemeral storage (/.session/**)
	NamespaceSession Namespace = ".session"

	// NamespaceAgents is the agent profile namespace (/.agents/**), writable but review-gated via folder autoapply.
	NamespaceAgents Namespace = ".agents"
)

// NamespaceService handles path normalization and namespace routing
type NamespaceService interface {
	// NormalizePath applies canonicalization rules, returns error if invalid
	// Rules:
	// - Trim leading/trailing whitespace
	// - Remove leading /
	// - Reject .. segments (path traversal)
	// - Collapse multiple / to single /
	// - Trim trailing /
	NormalizePath(path string) (string, error)

	// ParsePath extracts namespace and relative path from a normalized path
	// Example: ".meridian/skills/foo/SKILL.md" -> (NamespaceMeridian, "skills/foo/SKILL.md")
	// Example: "Characters/Aria.md" -> (NamespaceWorkspace, "Characters/Aria.md")
	ParsePath(path string) (namespace Namespace, relativePath string, err error)

	// EnsureMeridianFolder creates /.meridian/ folder if it doesn't exist.
	// Deprecated: keep until skills migrate off /.meridian.
	EnsureMeridianFolder(ctx context.Context, projectID string) (*Folder, error)

	// EnsureMeridianSubfolder creates /.meridian/<name>/ subfolder if it doesn't exist.
	// Example: EnsureMeridianSubfolder(ctx, projectID, "skills") creates /.meridian/skills/.
	// Deprecated: keep until skills migrate off /.meridian.
	EnsureMeridianSubfolder(ctx context.Context, projectID, name string) (*Folder, error)
}
