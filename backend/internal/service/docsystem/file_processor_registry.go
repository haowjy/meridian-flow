package docsystem

import (
	"sync"

	docsysSvc "meridian/internal/domain/services/docsystem"
)

// FileProcessorRegistry manages file processor strategies
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

// GetProcessor returns the first processor that can handle the given filename
// Returns nil if no processor can handle the file
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
