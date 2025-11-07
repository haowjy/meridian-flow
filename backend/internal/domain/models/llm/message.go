package llm

import (
	"time"
)

type Message struct {
	ID        string       `json:"id" db:"id"`
	ChatID    string       `json:"chat_id" db:"chat_id"`
	System    string       `json:"system_prompt"`
	Content   ContentBlock `json:"content"` // Input content
	UpdatedAt time.Time    `json:"updated_at" db:"updated_at"`
}

type ContentBlock struct {
	ID          *string `json:"id"`      // the "ID" of the reference, sometimes null if there is no existing reference (image)
	Content     *string `json:"content"` // if partialref, its the copied content, but ID contains reference to the full reference
	ContentType string  `json:"type"`    // "image", "reference", "partialref"
}
