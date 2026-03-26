package agents

import (
	"errors"
	"testing"

	domainerrors "meridian/internal/domain/errors"
)

// ---------------------------------------------------------------------------
// ValidateURL tests
// ---------------------------------------------------------------------------

func TestGitFetcher_ValidateURL_AcceptsHTTPS_AllowedHosts(t *testing.T) {
	f := NewGitFetcher()

	validURLs := []string{
		"https://github.com/user/repo",
		"https://github.com/user/repo.git",
		"https://gitlab.com/user/repo",
		"https://bitbucket.org/user/repo",
		"https://github.com/org/multi-word-repo",
	}

	for _, u := range validURLs {
		if err := f.ValidateURL(u); err != nil {
			t.Errorf("ValidateURL(%q) = %v, want nil", u, err)
		}
	}
}

func TestGitFetcher_ValidateURL_RejectsHTTP(t *testing.T) {
	f := NewGitFetcher()

	err := f.ValidateURL("http://github.com/user/repo")
	if err == nil {
		t.Fatal("expected error for HTTP URL, got nil")
	}

	var de *domainerrors.DomainError
	if !errors.As(err, &de) {
		t.Fatalf("expected *DomainError, got %T: %v", err, err)
	}
	if de.Code != domainerrors.CodeImportValidationFailed {
		t.Errorf("code: got %q, want %q", de.Code, domainerrors.CodeImportValidationFailed)
	}
}

func TestGitFetcher_ValidateURL_RejectsGitScheme(t *testing.T) {
	f := NewGitFetcher()

	err := f.ValidateURL("git://github.com/user/repo")
	if err == nil {
		t.Fatal("expected error for git:// URL, got nil")
	}

	var de *domainerrors.DomainError
	if !errors.As(err, &de) {
		t.Fatalf("expected *DomainError, got %T", err)
	}
}

func TestGitFetcher_ValidateURL_RejectsSSH(t *testing.T) {
	f := NewGitFetcher()

	err := f.ValidateURL("ssh://git@github.com/user/repo.git")
	if err == nil {
		t.Fatal("expected error for SSH URL, got nil")
	}
}

func TestGitFetcher_ValidateURL_RejectsDisallowedHost(t *testing.T) {
	f := NewGitFetcher()

	disallowed := []string{
		"https://evil.com/user/repo",
		"https://internal-server/repo",
		"https://169.254.169.254/latest/meta-data",    // AWS metadata endpoint
		"https://git.example.org/repo",
		"https://github.com.evil.com/user/repo",       // subdomain spoofing attempt
	}

	for _, u := range disallowed {
		err := f.ValidateURL(u)
		if err == nil {
			t.Errorf("ValidateURL(%q) = nil, want error", u)
			continue
		}
		var de *domainerrors.DomainError
		if !errors.As(err, &de) {
			t.Errorf("ValidateURL(%q): expected *DomainError, got %T", u, err)
			continue
		}
		if de.Code != domainerrors.CodeImportValidationFailed {
			t.Errorf("ValidateURL(%q): code = %q, want %q", u, de.Code, domainerrors.CodeImportValidationFailed)
		}
	}
}

func TestGitFetcher_ValidateURL_RejectsEmptyScheme(t *testing.T) {
	f := NewGitFetcher()

	err := f.ValidateURL("github.com/user/repo") // no scheme
	if err == nil {
		t.Fatal("expected error for scheme-less URL, got nil")
	}
}

func TestGitFetcher_ValidateURL_RejectsFileScheme(t *testing.T) {
	f := NewGitFetcher()

	err := f.ValidateURL("file:///etc/passwd")
	if err == nil {
		t.Fatal("expected error for file:// URL, got nil")
	}
}
