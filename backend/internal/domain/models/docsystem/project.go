package docsystem

import (
	"time"
)

type Project struct {
	ID           string     `json:"id" db:"id"`
	UserID       string     `json:"user_id" db:"user_id"`
	Name         string     `json:"name" db:"name"`
	SystemPrompt *string    `json:"system_prompt,omitempty" db:"system_prompt"`
	CreatedAt    time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at" db:"updated_at"`
	DeletedAt    *time.Time `json:"deleted_at,omitempty" db:"deleted_at"`
}
