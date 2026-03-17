// Collab v2 Backend Toy
//
// Demonstrates the backend data model concepts from the v2 spec:
// - Append-only update log (replaces overwrite-merge)
// - Checkpoint creation and compaction
// - Bookmark materialization
// - Status mirroring from _proposal_status Y.Map deltas
// - Two-phase GC strategy
//
// Run: cd toy && go run backend.go

package main

import (
	"fmt"
	"strings"
)

// ============================================================
// SIMULATED DATABASE TABLES (schema-design.md)
// ============================================================

type DocumentUpdate struct {
	ID     int
	DocID  string
	Update string // Simulated update content (real: BYTEA of Yjs update bytes)
	Origin string // "human" | "ai_proposal" | "accept" | "thread" | etc.
}

type DocumentCheckpoint struct {
	ID     int
	DocID  string
	State  string // Simulated merged state (real: BYTEA of merged Yjs state)
	UpToID int    // Includes all updates up to this ID
}

type DocumentBookmark struct {
	ID           string
	DocID        string
	UpdateID     *int    // Pointer into update log (nil once materialized)
	State        *string // Materialized blob (nil while pointer)
	BookmarkType string  // "manual" | "daily" | "auto_event"
	Name         string
}

type Proposal struct {
	ID               string
	DocumentID       string
	Status           string // "pending" | "accepted" | "rejected" | "stale" | "reverted"
	RegionTextBefore string
	RegionTextAfter  string
}

// ============================================================
// IN-MEMORY DATABASE
// ============================================================

var (
	updates     []DocumentUpdate
	checkpoints []DocumentCheckpoint
	bookmarks   []DocumentBookmark
	proposals   []Proposal
	nextID      = 1
	docText     = "" // Simulated canonical text
)

func appendUpdate(docID, content, origin string) int {
	id := nextID
	nextID++
	updates = append(updates, DocumentUpdate{
		ID: id, DocID: docID, Update: content, Origin: origin,
	})
	return id
}

func createCheckpoint(docID string, upToID int) {
	// Simulate merging all updates up to upToID into a state blob
	var parts []string
	for _, u := range updates {
		if u.DocID == docID && u.ID <= upToID {
			parts = append(parts, u.Update)
		}
	}
	state := "[merged: " + strings.Join(parts, " + ") + "]"

	checkpoints = append(checkpoints, DocumentCheckpoint{
		ID: len(checkpoints) + 1, DocID: docID, State: state, UpToID: upToID,
	})
}

func addBookmark(docID, bmType, name string, updateID int) {
	uid := updateID
	bookmarks = append(bookmarks, DocumentBookmark{
		ID: fmt.Sprintf("bm-%d", len(bookmarks)+1), DocID: docID,
		UpdateID: &uid, BookmarkType: bmType, Name: name,
	})
}

func createProposal(id, docID, before, after string) {
	proposals = append(proposals, Proposal{
		ID: id, DocumentID: docID, Status: "pending",
		RegionTextBefore: before, RegionTextAfter: after,
	})
}

// ============================================================
// STATUS MIRRORING (local-first-authority.md)
//
// Backend observes _proposal_status Y.Map deltas from Yjs sync
// and mirrors them to proposal rows. Key removal = back to pending.
// ============================================================

func mirrorStatus(proposalID, newStatus string) {
	for i := range proposals {
		if proposals[i].ID == proposalID {
			proposals[i].Status = newStatus
			return
		}
	}
}

// ============================================================
// COMPACTION (append-only-persistence.md)
//
// Threshold: 20k updates -> compact oldest 10k
// Steps:
//  1. Materialize manual/daily bookmarks in compaction range
//  2. Delete auto_event bookmarks in range
//  3. Merge updates into new checkpoint
//  4. Delete old update rows
// ============================================================

func compact(docID string, compactCount int) {
	fmt.Printf("  Compacting oldest %d updates...\n", compactCount)

	// Find update IDs in compaction range
	var rangeIDs []int
	for _, u := range updates {
		if u.DocID == docID && len(rangeIDs) < compactCount {
			rangeIDs = append(rangeIDs, u.ID)
		}
	}
	if len(rangeIDs) == 0 {
		return
	}
	maxID := rangeIDs[len(rangeIDs)-1]

	// Step 1: Materialize manual/daily bookmarks
	for i := range bookmarks {
		bm := &bookmarks[i]
		if bm.DocID != docID || bm.UpdateID == nil {
			continue
		}
		if *bm.UpdateID > maxID {
			continue
		}
		if bm.BookmarkType == "manual" || bm.BookmarkType == "daily" {
			uid := *bm.UpdateID
			state := fmt.Sprintf("[materialized state at update %d]", uid)
			bm.State = &state
			bm.UpdateID = nil // No longer a pointer -- self-contained
			fmt.Printf("  Materialized %s bookmark '%s' (was pointer to update %d)\n",
				bm.BookmarkType, bm.Name, uid)
		}
	}

	// Step 2: Delete auto_event bookmarks in range
	var keptBookmarks []DocumentBookmark
	for _, bm := range bookmarks {
		if bm.DocID == docID && bm.UpdateID != nil && *bm.UpdateID <= maxID && bm.BookmarkType == "auto_event" {
			fmt.Printf("  Deleted auto_event bookmark '%s'\n", bm.Name)
			continue
		}
		keptBookmarks = append(keptBookmarks, bm)
	}
	bookmarks = keptBookmarks

	// Step 3: Create checkpoint from compacted updates
	createCheckpoint(docID, maxID)
	fmt.Printf("  Created checkpoint up to update %d\n", maxID)

	// Step 4: Delete compacted updates
	var keptUpdates []DocumentUpdate
	for _, u := range updates {
		if u.DocID == docID && u.ID <= maxID {
			continue
		}
		keptUpdates = append(keptUpdates, u)
	}
	fmt.Printf("  Deleted %d update rows\n", len(updates)-len(keptUpdates))
	updates = keptUpdates
}

// ============================================================
// DISPLAY
// ============================================================

func printState(header string) {
	fmt.Printf("\n=== %s ===\n", header)
	fmt.Printf("  Document text: %q\n", docText)
	fmt.Printf("  Updates: %d rows\n", len(updates))
	for _, u := range updates {
		fmt.Printf("    [%d] %s (%s)\n", u.ID, u.Update, u.Origin)
	}
	fmt.Printf("  Checkpoints: %d\n", len(checkpoints))
	for _, c := range checkpoints {
		fmt.Printf("    [%d] up_to=%d state=%s\n", c.ID, c.UpToID, c.State)
	}
	fmt.Printf("  Bookmarks: %d\n", len(bookmarks))
	for _, bm := range bookmarks {
		if bm.UpdateID != nil {
			fmt.Printf("    %s (%s) '%s' -> update %d\n", bm.ID, bm.BookmarkType, bm.Name, *bm.UpdateID)
		} else {
			fmt.Printf("    %s (%s) '%s' -> MATERIALIZED\n", bm.ID, bm.BookmarkType, bm.Name)
		}
	}
	fmt.Printf("  Proposals: %d\n", len(proposals))
	for _, p := range proposals {
		fmt.Printf("    %s: %s (before=%q, after=%q)\n", p.ID, p.Status, p.RegionTextBefore, p.RegionTextAfter)
	}
}

// ============================================================
// WALKTHROUGH
// ============================================================

func main() {
	fmt.Println("Collab v2 Backend Toy")
	fmt.Println("=====================")
	fmt.Println()

	// --- Step 1: Writer types ---
	fmt.Println("Step 1: Writer types (append-only updates)")
	fmt.Println("  Each keystroke/batch appends a row -- no overwrites.")
	docText = "The cat sat on the mat."
	appendUpdate("doc1", "insert 'The '", "human")
	appendUpdate("doc1", "insert 'cat '", "human")
	appendUpdate("doc1", "insert 'sat on the mat.'", "human")
	printState("After typing")

	// --- Step 2: AI proposes edit ---
	fmt.Println("\nStep 2: AI proposes edit via edit_document")
	fmt.Println("  Backend creates proposal row with yjs_update bytes.")
	createProposal("P1", "doc1", "The cat", "The black cat")
	appendUpdate("doc1", "AI: insert 'black '", "ai_proposal")
	printState("After AI proposal")

	// --- Step 3: Writer accepts -> status mirror ---
	fmt.Println("\nStep 3: Writer accepts hunk (frontend Yjs transaction)")
	fmt.Println("  _proposal_status Y.Map update syncs to backend.")
	fmt.Println("  Backend mirrors Y.Map delta to proposal row status.")
	docText = "The black cat sat on the mat."
	mirrorStatus("P1", "accepted")
	appendUpdate("doc1", "accept P1: apply update + set status", "accept")
	printState("After accept + mirror")

	// --- Step 4: Daily bookmark ---
	fmt.Println("\nStep 4: Daily bookmark created (end of editing session)")
	fmt.Println("  Bookmark is a cheap pointer to an update_id.")
	addBookmark("doc1", "daily", "End of day 1", 5)
	printState("After daily bookmark")

	// --- Step 5: More writing accumulates ---
	fmt.Println("\nStep 5: More writing accumulates")
	for i := 0; i < 12; i++ {
		docText += "x"
		appendUpdate("doc1", fmt.Sprintf("typing batch %d", i+1), "human")
	}
	addBookmark("doc1", "auto_event", "AI session start", 10)
	addBookmark("doc1", "manual", "Before big rewrite", 15)

	// Second AI proposal
	createProposal("P2", "doc1", "the mat", "the rug")
	appendUpdate("doc1", "AI: replace 'mat' with 'rug'", "ai_proposal")

	printState("After more writing (18 updates)")

	// --- Step 6: Compaction ---
	fmt.Println("\nStep 6: Compaction (threshold reached)")
	fmt.Println("  Compact oldest 10 updates into a checkpoint.")
	fmt.Println("  Daily/manual bookmarks: materialized into full state blobs.")
	fmt.Println("  Auto-event bookmarks: deleted (ephemeral).")
	compact("doc1", 10)
	printState("After compaction")

	// --- Step 7: Thread undo ---
	fmt.Println("\nStep 7: Thread undo (simulated)")
	fmt.Println("  Text find-and-replace: no Yjs inverse needed.")
	fmt.Println("  Search canonical for region_text_after, replace with region_text_before.")

	p1 := &proposals[0]
	fmt.Printf("  Thread undo P1: search for %q\n", p1.RegionTextAfter)
	if strings.Contains(docText, p1.RegionTextAfter) {
		docText = strings.Replace(docText, p1.RegionTextAfter, p1.RegionTextBefore, 1)
		mirrorStatus("P1", "reverted")
		appendUpdate("doc1", "thread undo P1: text replace + status", "thread")
		fmt.Printf("  Found and replaced. New text: %q\n", docText)
		fmt.Println("  P1 status: accepted -> reverted (mirrored from Y.Map)")
	} else {
		fmt.Println("  NOT FOUND: conflict -- text was modified since accept")
	}

	// --- Step 8: Thread reapply ---
	fmt.Println("\nStep 8: Thread reapply (reverted -> accepted)")
	fmt.Printf("  Search canonical for %q\n", p1.RegionTextBefore)
	if strings.Contains(docText, p1.RegionTextBefore) {
		docText = strings.Replace(docText, p1.RegionTextBefore, p1.RegionTextAfter, 1)
		mirrorStatus("P1", "accepted")
		appendUpdate("doc1", "thread reapply P1: text replace + status", "thread")
		fmt.Printf("  Found and replaced. New text: %q\n", docText)
		fmt.Println("  P1 status: reverted -> accepted (mirrored from Y.Map)")
	} else {
		fmt.Println("  NOT FOUND: conflict")
	}

	// --- Step 9: GC strategy ---
	fmt.Println("\nStep 9: Two-phase GC strategy")
	fmt.Println("  Runtime: doc.gc = false (tombstones preserved for undo)")
	fmt.Println("  Compaction: doc.gc = true (tombstones GC'd into ID placeholders)")
	fmt.Println("  Result: checkpoint blob stays proportional to current doc size,")
	fmt.Println("  not entire editing history. Tombstone growth is bounded.")

	printState("Final state")

	fmt.Println("\n--- Summary ---")
	fmt.Println("Key concepts demonstrated:")
	fmt.Println("  1. Append-only: updates are rows, never overwritten")
	fmt.Println("  2. Checkpoints: merged state for fast document loading")
	fmt.Println("  3. Compaction: bounds storage by merging old updates")
	fmt.Println("  4. Bookmarks: cheap pointers, materialized on compaction")
	fmt.Println("  5. Status mirroring: Y.Map deltas -> proposal row status")
	fmt.Println("  6. Thread undo: text find-replace, survives compaction")
	fmt.Println("  7. Two-phase GC: runtime preserves, compaction cleans up")
}
