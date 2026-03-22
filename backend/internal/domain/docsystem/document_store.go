package docsystem

// DocumentStore is the composite document persistence contract.
type DocumentStore interface {
	DocumentReader
	DocumentWriter
	DocumentSearcher
	DocumentPathResolver
}
