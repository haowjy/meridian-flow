package handler

import (
	"fmt"
	"net/http"

	"meridian/internal/httputil"
)

// getProjectID extracts the project ID from the context
func getProjectID(r *http.Request) (string, error) {
	projectID := httputil.GetProjectID(r)
	if projectID == "" {
		return "", fmt.Errorf("project ID not found in context")
	}
	return projectID, nil
}

// getUserID extracts the user ID from the context
func getUserID(r *http.Request) (string, error) {
	userID := httputil.GetUserID(r)
	if userID == "" {
		return "", fmt.Errorf("user ID not found in context")
	}
	return userID, nil
}
