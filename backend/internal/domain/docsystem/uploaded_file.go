package docsystem

import "io"

// UploadedFile represents a file uploaded by the user for import
type UploadedFile struct {
	Filename string
	Content  io.Reader
}
