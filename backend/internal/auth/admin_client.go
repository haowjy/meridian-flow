package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// AdminClient provides access to Supabase Admin API for user management.
// This is used for seeding test users, not for regular authentication flow.
type AdminClient struct {
	supabaseURL string
	serviceKey  string
	httpClient  *http.Client
}

// NewAdminClient creates a new Supabase Admin API client.
// Requires the service role key (SUPABASE_KEY) for elevated permissions.
func NewAdminClient(supabaseURL, serviceKey string) *AdminClient {
	return &AdminClient{
		supabaseURL: supabaseURL,
		serviceKey:  serviceKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// CreateUserRequest is the payload for creating a new user
type CreateUserRequest struct {
	Email          string `json:"email"`
	Password       string `json:"password"`
	EmailConfirm   bool   `json:"email_confirm"`
	UserMetadata   map[string]interface{} `json:"user_metadata,omitempty"`
}

// CreateUserResponse is the response from creating a user
type CreateUserResponse struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Role  string `json:"role"`
}

// ListUsersResponse is the response from listing users
type ListUsersResponse struct {
	Users []CreateUserResponse `json:"users"`
}

// DeleteUserByEmail finds a user by email and deletes them.
// This is idempotent - returns nil if the user doesn't exist.
func (c *AdminClient) DeleteUserByEmail(email string) error {
	// First, find the user by email
	userID, err := c.findUserIDByEmail(email)
	if err != nil {
		// User not found is OK (idempotent)
		return nil
	}

	// Delete the user
	url := fmt.Sprintf("%s/auth/v1/admin/users/%s", c.supabaseURL, userID)
	req, err := http.NewRequest("DELETE", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create delete request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.serviceKey)
	req.Header.Set("apikey", c.serviceKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("delete user failed with status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// findUserIDByEmail searches for a user by email and returns their ID.
// Returns empty string if not found.
func (c *AdminClient) findUserIDByEmail(email string) (string, error) {
	url := fmt.Sprintf("%s/auth/v1/admin/users", c.supabaseURL)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create list request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.serviceKey)
	req.Header.Set("apikey", c.serviceKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to list users: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("list users failed with status %d: %s", resp.StatusCode, string(body))
	}

	var listResp ListUsersResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return "", fmt.Errorf("failed to decode list response: %w", err)
	}

	// Find user by email
	for _, user := range listResp.Users {
		if user.Email == email {
			return user.ID, nil
		}
	}

	return "", fmt.Errorf("user not found")
}

// CreateUser creates a new user with the specified email and password.
// The user is automatically confirmed (no email verification needed).
// Returns the user's UUID.
func (c *AdminClient) CreateUser(email, password string) (string, error) {
	url := fmt.Sprintf("%s/auth/v1/admin/users", c.supabaseURL)

	payload := CreateUserRequest{
		Email:        email,
		Password:     password,
		EmailConfirm: true, // Auto-confirm for test user
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("failed to marshal create request: %w", err)
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.serviceKey)
	req.Header.Set("apikey", c.serviceKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to create user: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("create user failed with status %d: %s", resp.StatusCode, string(body))
	}

	var createResp CreateUserResponse
	if err := json.Unmarshal(body, &createResp); err != nil {
		return "", fmt.Errorf("failed to decode create response: %w", err)
	}

	return createResp.ID, nil
}
