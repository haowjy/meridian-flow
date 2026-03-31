package handler

import (
	"fmt"
	"strings"
)

func normalizeUpsertInterjectionRequest(req *UpsertInterjectionRequest) error {
	if req == nil {
		return fmt.Errorf("interjection request is required")
	}

	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" {
		return fmt.Errorf("interjection content cannot be empty")
	}

	req.Mode = strings.TrimSpace(req.Mode)
	if req.Mode == "" {
		req.Mode = "append"
	}

	if req.Mode != "append" && req.Mode != "replace" {
		return fmt.Errorf("mode must be 'append' or 'replace'")
	}

	return nil
}
