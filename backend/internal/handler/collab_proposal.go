package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

const (
	wsTypeHeartbeat                = "heartbeat"
	wsTypeProposalAccept           = "proposal:accept"
	wsTypeProposalReject           = "proposal:reject"
	wsTypeProposalGroupAccept      = "proposal:groupAccept"
	wsTypeProposalSnapshot         = "proposal:snapshot"
	wsTypeProposalNew              = "proposal:new"
	wsTypeProposalStatusChanged    = "proposal:statusChanged"
	wsTypeProposalGroupAcceptEvent = "proposal:groupAcceptResult"
	wsTypeProposalRequestUpdate    = "proposal:requestUpdate"
	wsTypeProposalUpdateData       = "proposal:updateData"
)

type collabTypedMessage struct {
	Type string `json:"type"`
}

type proposalAcceptCommand struct {
	Type           string `json:"type"`
	DocumentID     string `json:"documentId"`
	ProposalID     string `json:"proposalId"`
	IdempotencyKey string `json:"idempotencyKey"`
}

type proposalRejectCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	ProposalID string `json:"proposalId"`
}

type proposalRequestUpdateCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	ProposalID string `json:"proposalId"`
}

type proposalUpdateDataEvent struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	ProposalID string `json:"proposalId"`
	YjsUpdate  string `json:"yjsUpdate"`
}

type proposalGroupAcceptCommand struct {
	Type           string `json:"type"`
	DocumentID     string `json:"documentId"`
	GroupID        string `json:"groupId"`
	IdempotencyKey string `json:"idempotencyKey"`
}

type proposalEventDTO struct {
	ID                string  `json:"id"`
	DocumentID        string  `json:"documentId"`
	Source            string  `json:"source"`
	ProducerAgentType string  `json:"producerAgentType"`
	ThreadID          string  `json:"threadId"`
	TurnID            *string `json:"turnId"`
	AgentRunID        string  `json:"agentRunId"`
	ProposalGroupID   *string `json:"proposalGroupId"`
	Status            string  `json:"status"`
	YjsUpdate         *string `json:"yjsUpdate,omitempty"`
	Description       *string `json:"description"`
	CreatedByUserID   string  `json:"createdByUserId"`
	CreatedAt         string  `json:"createdAt"`
}

type proposalSnapshotEvent struct {
	Type       string             `json:"type"`
	DocumentID string             `json:"documentId"`
	Proposals  []proposalEventDTO `json:"proposals"`
}

type proposalNewEvent struct {
	Type     string           `json:"type"`
	Proposal proposalEventDTO `json:"proposal"`
}

type proposalStatusChangedEvent struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	ProposalID string `json:"proposalId"`
	Status     string `json:"status"`
}

type proposalGroupAcceptResultEvent struct {
	Type       string                  `json:"type"`
	DocumentID string                  `json:"documentId"`
	Outcomes   []groupAcceptOutcomeDTO `json:"outcomes"`
}

type groupAcceptOutcomeDTO struct {
	ProposalID string  `json:"proposalId"`
	Status     string  `json:"status"`
	Error      *string `json:"error,omitempty"`
}

func (h *CollabHandler) handleProposalAccept(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	docID string,
	docUUID uuid.UUID,
	userUUID uuid.UUID,
	raw []byte,
) {
	if h.proposalService == nil {
		h.sendError(conn, "INTERNAL_ERROR", "proposal service unavailable")
		return
	}

	var cmd proposalAcceptCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "invalid proposal:accept payload")
		return
	}
	if strings.TrimSpace(cmd.IdempotencyKey) == "" {
		h.sendError(conn, "INTERNAL_ERROR", "idempotencyKey is required")
		return
	}
	commandDocumentID, ok := h.validateProposalCommandDocumentID(conn, cmd.DocumentID, docUUID)
	if !ok {
		return
	}

	proposalUUID, err := parseUUID(cmd.ProposalID)
	if err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "proposalId must be a valid UUID")
		return
	}

	requestHash, err := buildCanonicalRequestHash(map[string]any{
		"action":     wsTypeProposalAccept,
		"documentId": commandDocumentID.String(),
		"proposalId": proposalUUID.String(),
		"userId":     userUUID.String(),
	})
	if err != nil {
		h.logger.Error("collab accept request hash failed", "document_id", docID, "error", err)
		h.sendError(conn, "INTERNAL_ERROR", "failed to build request hash")
		return
	}

	result, err := h.proposalService.AcceptProposal(ctx, collabSvc.AcceptProposalRequest{
		ProposalID:        proposalUUID,
		UserID:            userUUID,
		IdempotencyKey:    strings.TrimSpace(cmd.IdempotencyKey),
		RequestHash:       requestHash,
		TransactionOrigin: conn.ID(),
	})
	if err != nil {
		h.sendError(conn, mapProposalErrorCode(err), err.Error())
		return
	}
	if result.IsReplay {
		h.sendError(conn, "IDEMPOTENCY_REPLAY", "proposal:accept already processed")
		return
	}
	if err := h.broadcastProposalMutations(projectID, result.Mutations); err != nil {
		h.logger.Error("collab accept mutation broadcast failed", "document_id", docID, "error", err)
		h.sendError(conn, "INTERNAL_ERROR", "failed to broadcast proposal updates")
	}
}

func (h *CollabHandler) handleProposalReject(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	docID string,
	docUUID uuid.UUID,
	userUUID uuid.UUID,
	raw []byte,
) {
	if h.proposalService == nil {
		h.sendError(conn, "INTERNAL_ERROR", "proposal service unavailable")
		return
	}

	var cmd proposalRejectCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "invalid proposal:reject payload")
		return
	}
	if _, ok := h.validateProposalCommandDocumentID(conn, cmd.DocumentID, docUUID); !ok {
		return
	}

	proposalUUID, err := parseUUID(cmd.ProposalID)
	if err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "proposalId must be a valid UUID")
		return
	}

	result, err := h.proposalService.RejectProposal(ctx, collabSvc.RejectProposalRequest{
		ProposalID: proposalUUID,
		UserID:     userUUID,
	})
	if err != nil {
		h.sendError(conn, mapProposalErrorCode(err), err.Error())
		return
	}
	if err := h.broadcastProposalMutations(projectID, result.Mutations); err != nil {
		h.logger.Error("collab reject mutation broadcast failed", "document_id", docID, "error", err)
		h.sendError(conn, "INTERNAL_ERROR", "failed to broadcast proposal updates")
	}
}

func (h *CollabHandler) handleProposalGroupAccept(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	docID string,
	docUUID uuid.UUID,
	userUUID uuid.UUID,
	raw []byte,
) {
	if h.proposalService == nil {
		h.sendError(conn, "INTERNAL_ERROR", "proposal service unavailable")
		return
	}

	var cmd proposalGroupAcceptCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "invalid proposal:groupAccept payload")
		return
	}
	if strings.TrimSpace(cmd.IdempotencyKey) == "" {
		h.sendError(conn, "INTERNAL_ERROR", "idempotencyKey is required")
		return
	}
	commandDocumentID, ok := h.validateProposalCommandDocumentID(conn, cmd.DocumentID, docUUID)
	if !ok {
		return
	}

	groupUUID, err := parseUUID(cmd.GroupID)
	if err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "groupId must be a valid UUID")
		return
	}

	requestHash, err := buildCanonicalRequestHash(map[string]any{
		"action":     wsTypeProposalGroupAccept,
		"documentId": commandDocumentID.String(),
		"groupId":    groupUUID.String(),
		"userId":     userUUID.String(),
	})
	if err != nil {
		h.logger.Error("collab group accept request hash failed", "document_id", docID, "error", err)
		h.sendError(conn, "INTERNAL_ERROR", "failed to build request hash")
		return
	}

	result, err := h.proposalService.GroupAccept(ctx, collabSvc.GroupAcceptRequest{
		DocumentID:        commandDocumentID,
		ProposalGroupID:   groupUUID,
		UserID:            userUUID,
		IdempotencyKey:    strings.TrimSpace(cmd.IdempotencyKey),
		RequestHash:       requestHash,
		TransactionOrigin: conn.ID(),
	})
	if err != nil {
		h.sendError(conn, mapProposalErrorCode(err), err.Error())
		return
	}

	if err := h.broadcastProposalMutations(projectID, result.Mutations); err != nil {
		h.logger.Error("collab group accept mutation broadcast failed", "document_id", docID, "error", err)
		h.sendError(conn, "INTERNAL_ERROR", "failed to broadcast proposal updates")
		return
	}

	groupEventBytes, err := buildProposalGroupAcceptResultEventBytes(commandDocumentID, result.Payload)
	if err != nil {
		h.logger.Error("collab group accept event encode failed", "document_id", docID, "error", err)
		h.sendError(conn, "INTERNAL_ERROR", "failed to encode group accept result")
		return
	}
	if h.projectRegistry != nil {
		h.projectRegistry.BroadcastToProject(projectID, groupEventBytes)
	}
}

// handleProposalRequestUpdate fetches a single proposal's yjsUpdate and sends
// it back as a unicast response. Used by the client to lazy-fetch update data
// for proposals loaded via snapshot (which intentionally omits yjsUpdate).
func (h *CollabHandler) handleProposalRequestUpdate(
	ctx context.Context,
	conn *websocketDocumentConnection,
	docID string,
	docUUID uuid.UUID,
	raw []byte,
) {
	if h.proposalStore == nil {
		h.sendError(conn, "INTERNAL_ERROR", "proposal store unavailable")
		return
	}

	var cmd proposalRequestUpdateCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "invalid proposal:requestUpdate payload")
		return
	}
	if _, ok := h.validateProposalCommandDocumentID(conn, cmd.DocumentID, docUUID); !ok {
		return
	}

	proposalUUID, err := parseUUID(cmd.ProposalID)
	if err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "proposalId must be a valid UUID")
		return
	}

	proposal, err := h.proposalStore.GetByID(ctx, proposalUUID)
	if err != nil {
		h.logger.Error("collab requestUpdate fetch failed", "document_id", docID, "proposal_id", cmd.ProposalID, "error", err)
		h.sendError(conn, mapProposalErrorCode(err), "proposal not found")
		return
	}

	// Validate the proposal belongs to the requested document
	if proposal.DocumentID != docUUID {
		h.sendError(conn, "FORBIDDEN", "proposal does not belong to this document")
		return
	}

	encoded := base64.StdEncoding.EncodeToString(proposal.YjsUpdate)
	if err := conn.SendJSON(proposalUpdateDataEvent{
		Type:       wsTypeProposalUpdateData,
		DocumentID: docUUID.String(),
		ProposalID: proposalUUID.String(),
		YjsUpdate:  encoded,
	}); err != nil {
		h.logger.Error("collab requestUpdate send failed", "document_id", docID, "error", err)
	}
}

func (h *CollabHandler) sendProposalSnapshot(
	ctx context.Context,
	conn *websocketDocumentConnection,
	docUUID uuid.UUID,
) error {
	if h.proposalStore == nil {
		return conn.SendJSON(buildProposalSnapshotEvent(docUUID, nil))
	}

	proposedStatus := collabModels.ProposalStatusProposed
	const pageSize = 200
	offset := 0
	proposals := make([]collabModels.Proposal, 0, pageSize)

	for {
		batch, err := h.proposalStore.ListByDocument(ctx, docUUID, &proposedStatus, pageSize, offset)
		if err != nil {
			return err
		}
		proposals = append(proposals, batch...)
		if len(batch) < pageSize {
			break
		}
		offset += len(batch)
	}

	sort.SliceStable(proposals, func(i, j int) bool {
		if proposals[i].CreatedAt.Equal(proposals[j].CreatedAt) {
			return proposals[i].ID.String() < proposals[j].ID.String()
		}
		return proposals[i].CreatedAt.Before(proposals[j].CreatedAt)
	})

	return conn.SendJSON(buildProposalSnapshotEvent(docUUID, proposals))
}

func (h *CollabHandler) broadcastProposalMutations(projectID string, mutations []collabSvc.ProposalMutationIntent) error {
	for _, mutation := range mutations {
		documentID := mutation.DocumentID.String()

		// Broadcast Yjs update to document WS connections (binary framing).
		if mutation.Status == collabModels.ProposalStatusAccepted && len(mutation.YjsUpdate) > 0 {
			if h.docHandler != nil {
				encodedUpdate, err := encodeSyncUpdatePayload(mutation.YjsUpdate)
				if err != nil {
					return err
				}
				h.docHandler.BroadcastToDocument(documentID, addDocPrefix(docWSPrefixSync, encodedUpdate))
			}
		}

		// Broadcast status change JSON event to project WS connections.
		statusEventBytes, err := buildProposalStatusChangedEventBytes(mutation.DocumentID, mutation.ProposalID, mutation.Status)
		if err != nil {
			return err
		}
		if h.projectRegistry != nil {
			h.projectRegistry.BroadcastToProject(projectID, statusEventBytes)
		}
	}
	return nil
}

func (h *CollabHandler) validateProposalCommandDocumentID(
	conn *websocketDocumentConnection,
	commandDocumentID string,
	socketDocumentID uuid.UUID,
) (uuid.UUID, bool) {
	documentUUID, err := parseUUID(commandDocumentID)
	if err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "documentId must be a valid UUID")
		return uuid.Nil, false
	}
	if documentUUID != socketDocumentID {
		h.sendError(conn, "INTERNAL_ERROR", "documentId must match websocket document")
		return uuid.Nil, false
	}
	return documentUUID, true
}

func mapProposalErrorCode(err error) string {
	var notFoundErr *domain.NotFoundError
	if errors.As(err, &notFoundErr) {
		return "PROPOSAL_NOT_FOUND"
	}

	var validationErr *domain.ValidationError
	if errors.As(err, &validationErr) {
		return "PROPOSAL_INVALID_STATE"
	}

	var conflictErr *domain.ConflictError
	if errors.As(err, &conflictErr) && conflictErr.ResourceType == "idempotency_key" {
		return "IDEMPOTENCY_KEY_CONFLICT"
	}

	var rateLimitErr *domain.RateLimitError
	if errors.As(err, &rateLimitErr) {
		return "RATE_LIMITED"
	}

	var forbiddenErr *domain.ForbiddenError
	if errors.As(err, &forbiddenErr) {
		return "FORBIDDEN"
	}

	return "INTERNAL_ERROR"
}

func buildProposalSnapshotEvent(documentID uuid.UUID, proposals []collabModels.Proposal) proposalSnapshotEvent {
	out := make([]proposalEventDTO, 0, len(proposals))
	for _, proposal := range proposals {
		out = append(out, toProposalEventDTO(proposal, false))
	}
	return proposalSnapshotEvent{
		Type:       wsTypeProposalSnapshot,
		DocumentID: documentID.String(),
		Proposals:  out,
	}
}

func buildProposalNewEvent(proposal collabModels.Proposal) proposalNewEvent {
	return proposalNewEvent{
		Type:     wsTypeProposalNew,
		Proposal: toProposalEventDTO(proposal, true),
	}
}

func buildProposalStatusChangedEvent(
	documentID uuid.UUID,
	proposalID uuid.UUID,
	status collabModels.ProposalStatus,
) proposalStatusChangedEvent {
	return proposalStatusChangedEvent{
		Type:       wsTypeProposalStatusChanged,
		DocumentID: documentID.String(),
		ProposalID: proposalID.String(),
		Status:     string(status),
	}
}

func buildProposalStatusChangedEventBytes(
	documentID uuid.UUID,
	proposalID uuid.UUID,
	status collabModels.ProposalStatus,
) ([]byte, error) {
	return json.Marshal(buildProposalStatusChangedEvent(documentID, proposalID, status))
}

func buildProposalGroupAcceptResultEvent(
	documentID uuid.UUID,
	payload collabModels.GroupAcceptResponsePayload,
) proposalGroupAcceptResultEvent {
	outcomes := make([]groupAcceptOutcomeDTO, 0, len(payload.Outcomes))
	for _, outcome := range payload.Outcomes {
		outcomes = append(outcomes, groupAcceptOutcomeDTO{
			ProposalID: outcome.ProposalID.String(),
			Status:     string(outcome.Status),
			Error:      outcome.Error,
		})
	}
	return proposalGroupAcceptResultEvent{
		Type:       wsTypeProposalGroupAcceptEvent,
		DocumentID: documentID.String(),
		Outcomes:   outcomes,
	}
}

func buildProposalGroupAcceptResultEventBytes(
	documentID uuid.UUID,
	payload collabModels.GroupAcceptResponsePayload,
) ([]byte, error) {
	return json.Marshal(buildProposalGroupAcceptResultEvent(documentID, payload))
}

func toProposalEventDTO(proposal collabModels.Proposal, includeYjsUpdate bool) proposalEventDTO {
	turnID := uuidToPtrString(proposal.TurnID)
	groupID := uuidToPtrString(proposal.ProposalGroupID)

	var yjsUpdate *string
	if includeYjsUpdate {
		encoded := base64.StdEncoding.EncodeToString(proposal.YjsUpdate)
		yjsUpdate = &encoded
	}

	return proposalEventDTO{
		ID:                proposal.ID.String(),
		DocumentID:        proposal.DocumentID.String(),
		Source:            string(proposal.Source),
		ProducerAgentType: proposal.ProducerAgentType,
		ThreadID:          proposal.ThreadID.String(),
		TurnID:            turnID,
		AgentRunID:        proposal.AgentRunID.String(),
		ProposalGroupID:   groupID,
		Status:            string(proposal.Status),
		YjsUpdate:         yjsUpdate,
		Description:       proposal.Description,
		CreatedByUserID:   proposal.CreatedByUserID.String(),
		CreatedAt:         proposal.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func uuidToPtrString(v *uuid.UUID) *string {
	if v == nil {
		return nil
	}
	s := v.String()
	return &s
}

func buildCanonicalRequestHash(payload any) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", err
	}

	canonical, err := canonicalJSONBytes(parsed)
	if err != nil {
		return "", err
	}

	sum := sha256.Sum256(canonical)
	return fmt.Sprintf("%x", sum), nil
}

func canonicalJSONBytes(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeCanonicalJSON(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeCanonicalJSON(buf *bytes.Buffer, v any) error {
	switch value := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if value {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case string:
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		buf.Write(encoded)
	case float64:
		buf.WriteString(strconv.FormatFloat(value, 'f', -1, 64))
	case []any:
		buf.WriteByte('[')
		for i, item := range value {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonicalJSON(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(value))
		for k := range value {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		buf.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			encodedKey, err := json.Marshal(key)
			if err != nil {
				return err
			}
			buf.Write(encodedKey)
			buf.WriteByte(':')
			if err := writeCanonicalJSON(buf, value[key]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		return fmt.Errorf("unsupported canonical json type: %T", v)
	}

	return nil
}
