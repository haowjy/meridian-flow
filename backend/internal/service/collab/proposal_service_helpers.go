package collab

import (
	"fmt"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"

	collabModels "meridian/internal/domain/models/collab"
)

func buildProposalAcceptedStatusUpdate(proposalID uuid.UUID) ([]byte, error) {
	doc := ycrdt.NewDoc("proposal-backend-fallback-status", true, ycrdt.DefaultGCFilter, nil, false)
	statusMap := doc.GetMap("_proposal_status").(*ycrdt.YMap)

	doc.Transact(func(_ *ycrdt.Transaction) {
		statusMap.Set(proposalID.String(), string(collabModels.ProposalStatusAccepted))
	}, nil)

	update, err := safeEncodeStateAsUpdateForFallback(doc)
	if err != nil {
		return nil, fmt.Errorf("encode accepted status update: %w", err)
	}
	if len(update) == 0 {
		return nil, fmt.Errorf("encoded empty accepted status update")
	}
	return update, nil
}

func safeEncodeStateAsUpdateForFallback(doc *ycrdt.Doc) (state []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("encode state as update panic: %v", r)
		}
	}()
	return ycrdt.EncodeStateAsUpdate(doc, nil), nil
}
