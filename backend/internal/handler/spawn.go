package handler

// spawn.go — Spawn-related endpoints for the ThreadHandler.
//
// GET /api/threads/{id}/spawns returns the list of child threads spawned from
// a given parent thread, including their spawn_status and spawn_result fields.
// The caller must have access to the parent thread (auth enforced by ThreadService).

import (
	"net/http"

	"meridian/internal/httputil"
)

// SpawnSummary is the response shape for each child thread in the spawn list.
// It mirrors the Thread struct but is typed to clarify intent on the wire.
// All spawn-specific fields (spawn_status, spawn_result, spawn_depth) are already
// present on the Thread domain object and are serialised via JSON tags.
type SpawnListResponse struct {
	// Spawns is the ordered list of child threads (oldest first).
	Spawns []spawnEntry `json:"spawns"`
}

type spawnEntry struct {
	ID            string      `json:"id"`
	Title         string      `json:"title"`
	Persona       *string     `json:"persona,omitempty"`
	SpawnStatus   interface{} `json:"spawn_status,omitempty"`
	SpawnResult   interface{} `json:"spawn_result,omitempty"`
	SpawnDepth    int         `json:"spawn_depth"`
	ParentThreadID *string    `json:"parent_thread_id,omitempty"`
	CreatedAt     interface{} `json:"created_at"`
	UpdatedAt     interface{} `json:"updated_at"`
}

// ListSpawns returns all child threads spawned from a parent thread.
// GET /api/threads/{id}/spawns
//
// Response: { "spawns": [ {id, title, persona, spawn_status, spawn_result, ...}, ... ] }
//
// Returns 404 if the parent thread does not exist or the caller lacks access.
// Returns an empty spawns array (not 404) when the parent has no children.
func (h *ThreadHandler) ListSpawns(w http.ResponseWriter, r *http.Request) {
	threadID, ok := PathParam(w, r, "id", "Thread ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	children, err := h.threadService.ListChildThreads(r.Context(), threadID, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	// Map domain threads to spawn entries.
	entries := make([]spawnEntry, 0, len(children))
	for _, child := range children {
		entry := spawnEntry{
			ID:             child.ID,
			Title:          child.Title,
			Persona:        child.Persona,
			SpawnStatus:    child.SpawnStatus,
			SpawnResult:    child.SpawnResultJSON,
			SpawnDepth:     child.SpawnDepth,
			ParentThreadID: child.ParentThreadID,
			CreatedAt:      child.CreatedAt,
			UpdatedAt:      child.UpdatedAt,
		}
		entries = append(entries, entry)
	}

	httputil.RespondJSON(w, http.StatusOK, SpawnListResponse{Spawns: entries})
}
