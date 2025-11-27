package docsystem

import (
	"sync"

	docsysSvc "meridian/internal/domain/services/docsystem"
)

// FileProcessorRegistry manages file processor strategies using the Strategy pattern.
//
// Architecture: Each processor handles a specific file type (zip vs individual files).
// The registry routes incoming files to the appropriate processor based on CanProcess().
//
// Extensibility: To add a new file type (e.g., Google Drive links):
//  1. Implement FileProcessor interface
//  2. Call registry.Register(NewGoogleDriveProcessor())
//  3. No changes needed to existing code (OCP compliant)
//
// Thread-safe for concurrent access during request handling.
type FileProcessorRegistry struct {
	mu         sync.RWMutex
	processors []docsysSvc.FileProcessor
}

// NewFileProcessorRegistry creates a new file processor registry
func NewFileProcessorRegistry() *FileProcessorRegistry {
	return &FileProcessorRegistry{
		processors: make([]docsysSvc.FileProcessor, 0),
	}
}

// Register adds a file processor to the registry
func (r *FileProcessorRegistry) Register(processor docsysSvc.FileProcessor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.processors = append(r.processors, processor)
}

// GetProcessor returns the first processor that can handle the given filename.
// Returns nil if no processor can handle the file.
//
// Note: Uses "first match wins" - processors are checked in registration order.
// Currently: ZipFileProcessor is registered before IndividualFileProcessor,
// so .zip files are always handled by ZipFileProcessor.
func (r *FileProcessorRegistry) GetProcessor(filename string) docsysSvc.FileProcessor {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, processor := range r.processors {
		if processor.CanProcess(filename) {
			return processor
		}
	}
	return nil
}
