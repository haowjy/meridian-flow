package converter

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	docsysSvc "meridian/internal/domain/services/docsystem"
)

// ConverterRegistry manages content converters and routes files by extension.
// Follows Factory + Registry pattern (similar to LLM AdapterFactory + ProviderRegistry).
//
// Thread-safe for concurrent access.
type ConverterRegistry struct {
	mu         sync.RWMutex
	converters map[string]docsysSvc.ContentConverter // key: file extension (e.g., ".html")
}

// NewConverterRegistry creates a registry with standard converters pre-registered.
func NewConverterRegistry() *ConverterRegistry {
	registry := &ConverterRegistry{
		converters: make(map[string]docsysSvc.ContentConverter),
	}

	// Register standard converters
	registry.Register(NewMarkdownConverter())
	registry.Register(NewTextConverter())
	registry.Register(NewHTMLConverter())

	return registry
}

// Register adds a converter and associates it with its supported extensions.
// Enables extension without modification (OCP).
//
// Extensions are automatically normalized to lowercase with leading dot.
func (r *ConverterRegistry) Register(converter docsysSvc.ContentConverter) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, ext := range converter.SupportedExtensions() {
		ext = strings.ToLower(ext)
		if !strings.HasPrefix(ext, ".") {
			ext = "." + ext
		}
		r.converters[ext] = converter
	}
}

// GetConverter retrieves a converter for the given file extension.
// Returns nil if no converter is registered for this extension.
//
// Extension lookup is case-insensitive.
func (r *ConverterRegistry) GetConverter(fileExt string) docsysSvc.ContentConverter {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.converters[strings.ToLower(fileExt)]
}

// Convert automatically selects the appropriate converter based on file extension
// and performs the conversion.
//
// Returns an error if no converter is registered for the file type or if conversion fails.
func (r *ConverterRegistry) Convert(ctx context.Context, filename string, content []byte) (string, error) {
	ext := filepath.Ext(filename)
	converter := r.GetConverter(ext)

	if converter == nil {
		return "", fmt.Errorf("unsupported file type: %s", ext)
	}

	return converter.Convert(ctx, content)
}

// SupportedExtensions returns all registered file extensions.
func (r *ConverterRegistry) SupportedExtensions() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	exts := make([]string, 0, len(r.converters))
	for ext := range r.converters {
		exts = append(exts, ext)
	}
	return exts
}
