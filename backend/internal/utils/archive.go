package utils

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
)

// CreateZipFromDirectory creates a zip file from all markdown files in a directory
func CreateZipFromDirectory(dirPath string) (buf *bytes.Buffer, err error) {
	zipBuffer := new(bytes.Buffer)
	zipWriter := zip.NewWriter(zipBuffer)
	defer func() {
		// Close() finalizes the zip - must check its error
		if closeErr := zipWriter.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()

	// Walk through the directory
	err = filepath.Walk(dirPath, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		// Skip directories
		if info.IsDir() {
			return nil
		}

		// Only include .md files
		if filepath.Ext(path) != ".md" {
			return nil
		}

		// Get relative path from base directory
		relPath, err := filepath.Rel(dirPath, path)
		if err != nil {
			return err
		}

		// Create file in zip
		fileWriter, err := zipWriter.Create(relPath)
		if err != nil {
			return err
		}

		// Read file content
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		// Write content to zip
		_, err = fileWriter.Write(content)
		if err != nil {
			return err
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	return zipBuffer, nil
}
