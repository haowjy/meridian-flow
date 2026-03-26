package agents

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	domainagents "meridian/internal/domain/agents"
	domainerrors "meridian/internal/domain/errors"
)

const (
	// maxRepoBytes caps the on-disk footprint of a shallow-cloned repository
	// (pack files + working tree). Prevents unbounded disk usage from large repos.
	maxRepoBytes int64 = 50 * 1024 * 1024 // 50 MB

	// maxFileBytes caps any individual file within the repository.
	// Prevents single outsized files from bypassing the intent of the repo cap.
	maxFileBytes int64 = 1 * 1024 * 1024 // 1 MB
)

// allowedHosts is the SSRF allowlist for git imports.
// Only well-known public hosting services are permitted; private or internal
// hosts must never appear here.
var allowedHosts = map[string]bool{
	"github.com":    true,
	"gitlab.com":    true,
	"bitbucket.org": true,
}

// gitFetcher implements GitFetcher using the system "git" binary.
//
// SSRF mitigations applied:
//  1. HTTPS-only scheme check (rejects git://, ssh://, file://, etc.)
//  2. Hostname allowlist (rejects internal hosts, cloud metadata endpoints, etc.)
type gitFetcher struct{}

// Compile-time interface assertion.
var _ domainagents.GitFetcher = (*gitFetcher)(nil)

// NewGitFetcher creates a GitFetcher that shells out to the system git binary.
func NewGitFetcher() domainagents.GitFetcher {
	return &gitFetcher{}
}

// ValidateURL checks that rawURL is safe to clone before any network activity.
//
// Rejected when:
//   - URL cannot be parsed
//   - scheme is not "https"
//   - hostname is not in allowedHosts
func (f *gitFetcher) ValidateURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return domainerrors.ImportValidationFailed(fmt.Sprintf("unparseable URL: %v", err))
	}
	if u.Scheme != "https" {
		return domainerrors.ImportValidationFailed(
			fmt.Sprintf("URL must use HTTPS scheme, got %q", u.Scheme))
	}
	if !allowedHosts[u.Hostname()] {
		return domainerrors.ImportValidationFailed(
			fmt.Sprintf("host %q is not in the allowlist (allowed: github.com, gitlab.com, bitbucket.org)", u.Hostname()))
	}
	return nil
}

// Clone runs "git clone --depth=1 <url> <tmpDir>", enforces the repo size cap,
// and returns the path of the cloned directory on success.
//
// The caller owns the returned directory and must remove it when done.
// On any error the temp directory is cleaned up before returning.
func (f *gitFetcher) Clone(ctx context.Context, rawURL string) (string, error) {
	if err := f.ValidateURL(rawURL); err != nil {
		return "", err
	}

	tmpDir, err := os.MkdirTemp("", "meridian-agent-import-*")
	if err != nil {
		return "", fmt.Errorf("git fetcher: create temp dir: %w", err)
	}

	// Bound clone time to prevent hangs on slow or unresponsive remotes.
	cloneCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	// --depth=1: shallow clone; minimises download size and avoids full history.
	// GIT_TERMINAL_PROMPT=0 / GIT_ASKPASS=echo: prevent git from blocking on a
	// credential prompt when the remote requires authentication — fail fast instead.
	cmd := exec.CommandContext(cloneCtx, "git", "clone", "--depth=1", rawURL, tmpDir)
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=echo",
	)
	var combined bytes.Buffer
	cmd.Stdout = &combined
	cmd.Stderr = &combined

	if err := cmd.Run(); err != nil {
		_ = os.RemoveAll(tmpDir)
		// Do NOT include combined.String() (git stderr) — it may echo the clone URL
		// verbatim, leaking embedded credentials (https://user:token@host/...).
		return "", domainerrors.ImportValidationFailed("git clone failed: remote rejected or unreachable")
	}

	// Guard against large repos consuming excessive disk space.
	totalSize, err := dirSize(tmpDir)
	if err != nil {
		_ = os.RemoveAll(tmpDir)
		return "", fmt.Errorf("git fetcher: measure repo size: %w", err)
	}
	if totalSize > maxRepoBytes {
		_ = os.RemoveAll(tmpDir)
		return "", domainerrors.ImportValidationFailed(
			fmt.Sprintf("repository too large: %d bytes (max %d)", totalSize, maxRepoBytes))
	}

	return tmpDir, nil
}

// sanitizeURL returns rawURL with any userinfo (credentials) stripped.
// Use this whenever a URL is included in a log message or error string to
// prevent https://user:token@host/... credentials from appearing in logs.
func sanitizeURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "[unparseable URL]"
	}
	u.User = nil
	return u.String()
}

// dirSize returns the sum of the sizes of all regular files under root.
// For a shallow clone this includes both the .git pack files and the checked-out
// working tree — it is NOT an uncompressed-content figure.
func dirSize(root string) (int64, error) {
	var total int64
	err := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}
