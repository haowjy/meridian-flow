package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// RenderTemplate reads a prompt template and substitutes {{KEY}} placeholders
// with the provided variable values. This replaces the awk-based render()
// function from the original run.sh.
func RenderTemplate(promptsDir, templateName string, vars map[string]string) (string, error) {
	templatePath := filepath.Join(promptsDir, templateName)

	content, err := os.ReadFile(templatePath)
	if err != nil {
		return "", fmt.Errorf("reading template %s: %w", templateName, err)
	}

	result := string(content)
	for key, val := range vars {
		placeholder := "{{" + key + "}}"
		result = strings.ReplaceAll(result, placeholder, val)
	}

	return result, nil
}
