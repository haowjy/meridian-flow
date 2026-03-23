package billing

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	billing "meridian/internal/domain/billing"
	"meridian/internal/repository/postgres"
)

const (
	settlementStatusPending = "pending"

	metadataKeyBilling     = "billing"
	metadataKeySettlements = "settlements"
)

type GenerationBillingStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

var _ billing.GenerationBillingStore = (*GenerationBillingStore)(nil)

func NewGenerationBillingStore(config *postgres.RepositoryConfig) billing.GenerationBillingStore {
	return &GenerationBillingStore{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

func (s *GenerationBillingStore) SetBillingFields(
	ctx context.Context,
	turnID string,
	requestIndex int,
	fields billing.BillingFields,
) error {
	if requestIndex < 0 {
		return fmt.Errorf("billing request_index must be >= 0")
	}

	return s.withTurnMetadataTx(ctx, turnID, func(metadata map[string]interface{}) error {
		settlements, err := parseSettlementsFromMetadata(metadata)
		if err != nil {
			return err
		}
		settlements = ensureSettlementCapacity(settlements, requestIndex)

		entry, err := parseSettlementEntry(settlements[requestIndex])
		if err != nil {
			return err
		}

		if fields.UserID != "" {
			entry.UserID = fields.UserID
		}
		if fields.UsageEventID != "" {
			entry.UsageEventID = fields.UsageEventID
		}
		if fields.ConsumptionGroupID != uuid.Nil {
			entry.ConsumptionGroupID = fields.ConsumptionGroupID.String()
		}
		if fields.AmountMillicredits > 0 {
			entry.AmountMillicredits = fields.AmountMillicredits
		}
		if fields.Status != "" {
			entry.Status = fields.Status
		} else if entry.Status == "" {
			entry.Status = settlementStatusPending
		}
		entry.LastError = fields.LastError
		entry.RetryCount = fields.RetryCount
		entry.UpdatedAt = time.Now().UTC()

		settlements[requestIndex] = entry.toMap()
		writeSettlementsToMetadata(metadata, settlements)
		return nil
	})
}

func (s *GenerationBillingStore) GetBillingFields(
	ctx context.Context,
	turnID string,
	requestIndex int,
) (*billing.BillingFields, error) {
	metadata, err := s.loadTurnMetadata(ctx, turnID)
	if err != nil {
		return nil, err
	}

	settlements, err := parseSettlementsFromMetadata(metadata)
	if err != nil {
		return nil, err
	}
	if requestIndex < 0 || requestIndex >= len(settlements) || settlements[requestIndex] == nil {
		return nil, nil
	}

	record, err := parseSettlementEntry(settlements[requestIndex])
	if err != nil {
		return nil, err
	}

	fields := &billing.BillingFields{
		UserID:             record.UserID,
		UsageEventID:       record.UsageEventID,
		AmountMillicredits: record.AmountMillicredits,
		Status:             record.Status,
		LastError:          record.LastError,
		RetryCount:         record.RetryCount,
	}

	if record.ConsumptionGroupID != "" {
		parsed, parseErr := uuid.Parse(record.ConsumptionGroupID)
		if parseErr != nil {
			return nil, fmt.Errorf("parse billing consumption_group_id: %w", parseErr)
		}
		fields.ConsumptionGroupID = parsed
	}

	return fields, nil
}

func (s *GenerationBillingStore) MarkBillingStatus(
	ctx context.Context,
	turnID string,
	requestIndex int,
	status string,
	lastError string,
) error {
	if requestIndex < 0 {
		return fmt.Errorf("billing request_index must be >= 0")
	}

	return s.withTurnMetadataTx(ctx, turnID, func(metadata map[string]interface{}) error {
		settlements, err := parseSettlementsFromMetadata(metadata)
		if err != nil {
			return err
		}
		if requestIndex < 0 || requestIndex >= len(settlements) || settlements[requestIndex] == nil {
			return fmt.Errorf("billing settlement request_index %d not found for turn %s", requestIndex, turnID)
		}

		record, err := parseSettlementEntry(settlements[requestIndex])
		if err != nil {
			return err
		}
		record.Status = status
		record.LastError = lastError
		record.UpdatedAt = time.Now().UTC()

		settlements[requestIndex] = record.toMap()
		writeSettlementsToMetadata(metadata, settlements)
		return nil
	})
}

func (s *GenerationBillingStore) ListPendingSettlements(
	ctx context.Context,
	olderThan time.Time,
	limit int,
) ([]billing.PendingSettlement, error) {
	if limit <= 0 {
		return []billing.PendingSettlement{}, nil
	}

	query := fmt.Sprintf(`
		SELECT id, response_metadata
		FROM %s
		WHERE jsonb_path_exists(response_metadata, '$.billing.settlements[*] ? (@.billing_status == "pending")')
		ORDER BY created_at ASC
		LIMIT $1
	`, s.tables.Turns)

	executor := postgres.GetExecutor(ctx, s.pool)
	rows, err := executor.Query(ctx, query, limit*10)
	if err != nil {
		return nil, fmt.Errorf("list pending settlements: %w", err)
	}
	defer rows.Close()

	results := make([]billing.PendingSettlement, 0, limit)
	for rows.Next() {
		if len(results) >= limit {
			break
		}

		var turnID string
		var rawMetadata []byte
		if err := rows.Scan(&turnID, &rawMetadata); err != nil {
			return nil, fmt.Errorf("scan pending settlement row: %w", err)
		}

		metadata, err := parseRawMetadata(rawMetadata)
		if err != nil {
			s.logger.Warn("failed to parse response metadata while listing pending settlements",
				"turn_id", turnID,
				"error", err,
			)
			continue
		}

		settlements, err := parseSettlementsFromMetadata(metadata)
		if err != nil {
			s.logger.Warn("failed to parse billing settlements while listing pending settlements",
				"turn_id", turnID,
				"error", err,
			)
			continue
		}

		for requestIndex, rawSettlement := range settlements {
			if len(results) >= limit {
				break
			}
			if rawSettlement == nil {
				continue
			}

			record, err := parseSettlementEntry(rawSettlement)
			if err != nil {
				s.logger.Warn("failed to parse pending settlement entry",
					"turn_id", turnID,
					"request_index", requestIndex,
					"error", err,
				)
				continue
			}
			if record.Status != settlementStatusPending {
				continue
			}
			if !record.UpdatedAt.IsZero() && record.UpdatedAt.After(olderThan) {
				continue
			}

			fields := billing.BillingFields{
				UserID:             record.UserID,
				UsageEventID:       record.UsageEventID,
				AmountMillicredits: record.AmountMillicredits,
				Status:             record.Status,
				LastError:          record.LastError,
				RetryCount:         record.RetryCount,
			}
			if record.ConsumptionGroupID != "" {
				if parsed, err := uuid.Parse(record.ConsumptionGroupID); err == nil {
					fields.ConsumptionGroupID = parsed
				}
			}
			// Reconciliation only retries write-ahead-complete pending rows.
			// Deferred-to-enrichment placeholders (no amount/user/group) are skipped.
			if fields.UserID == "" || fields.UsageEventID == "" || fields.ConsumptionGroupID == uuid.Nil || fields.AmountMillicredits <= 0 {
				continue
			}

			results = append(results, billing.PendingSettlement{
				TurnID:       turnID,
				RequestIndex: requestIndex,
				Billing:      fields,
			})
		}
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pending settlements: %w", err)
	}

	return results, nil
}

func (s *GenerationBillingStore) loadTurnMetadata(ctx context.Context, turnID string) (map[string]interface{}, error) {
	query := fmt.Sprintf(`SELECT response_metadata FROM %s WHERE id = $1`, s.tables.Turns)

	executor := postgres.GetExecutor(ctx, s.pool)
	var rawMetadata []byte
	if err := executor.QueryRow(ctx, query, turnID).Scan(&rawMetadata); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("turn", fmt.Sprintf("turn %s not found", turnID))
		}
		return nil, fmt.Errorf("load turn metadata: %w", err)
	}

	return parseRawMetadata(rawMetadata)
}

func (s *GenerationBillingStore) withTurnMetadataTx(
	ctx context.Context,
	turnID string,
	mutate func(metadata map[string]interface{}) error,
) error {
	return s.withTx(ctx, func(txCtx context.Context, tx pgx.Tx) error {
		loadQuery := fmt.Sprintf(`SELECT response_metadata FROM %s WHERE id = $1 FOR UPDATE`, s.tables.Turns)

		var rawMetadata []byte
		if err := tx.QueryRow(txCtx, loadQuery, turnID).Scan(&rawMetadata); err != nil {
			if postgres.IsPgNoRowsError(err) {
				return domain.NewNotFoundError("turn", fmt.Sprintf("turn %s not found", turnID))
			}
			return fmt.Errorf("load turn metadata for billing mutation: %w", err)
		}

		metadata, err := parseRawMetadata(rawMetadata)
		if err != nil {
			return err
		}

		if err := mutate(metadata); err != nil {
			return err
		}

		updateQuery := fmt.Sprintf(`UPDATE %s SET response_metadata = $2 WHERE id = $1`, s.tables.Turns)
		if _, err := tx.Exec(txCtx, updateQuery, turnID, metadata); err != nil {
			return fmt.Errorf("persist billing metadata: %w", err)
		}

		return nil
	})
}

func parseRawMetadata(rawMetadata []byte) (map[string]interface{}, error) {
	if len(rawMetadata) == 0 {
		return map[string]interface{}{}, nil
	}

	var metadata map[string]interface{}
	if err := json.Unmarshal(rawMetadata, &metadata); err != nil {
		return nil, fmt.Errorf("unmarshal response_metadata: %w", err)
	}
	if metadata == nil {
		return map[string]interface{}{}, nil
	}
	return metadata, nil
}

type settlementEntry struct {
	UserID             string    `json:"billing_user_id,omitempty"`
	UsageEventID       string    `json:"billing_usage_event_id,omitempty"`
	ConsumptionGroupID string    `json:"billing_consumption_group_id,omitempty"`
	AmountMillicredits int64     `json:"billing_amount_millicredits,omitempty"`
	Status             string    `json:"billing_status,omitempty"`
	LastError          string    `json:"billing_last_error,omitempty"`
	RetryCount         int       `json:"billing_retry_count,omitempty"`
	UpdatedAt          time.Time `json:"billing_updated_at,omitempty"`
}

func parseSettlementsFromMetadata(metadata map[string]interface{}) ([]interface{}, error) {
	if metadata == nil {
		return []interface{}{}, nil
	}

	billingRaw, hasBilling := metadata[metadataKeyBilling]
	if !hasBilling || billingRaw == nil {
		return []interface{}{}, nil
	}

	billingMap, ok := billingRaw.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("response_metadata.billing is not an object")
	}

	settlementsRaw, hasSettlements := billingMap[metadataKeySettlements]
	if !hasSettlements || settlementsRaw == nil {
		return []interface{}{}, nil
	}

	settlements, ok := settlementsRaw.([]interface{})
	if ok {
		return settlements, nil
	}

	// Support map-backed decode fallback by converting to []interface{}.
	settlementsBytes, err := json.Marshal(settlementsRaw)
	if err != nil {
		return nil, fmt.Errorf("marshal billing settlements: %w", err)
	}

	var normalized []interface{}
	if err := json.Unmarshal(settlementsBytes, &normalized); err != nil {
		return nil, fmt.Errorf("unmarshal billing settlements: %w", err)
	}
	return normalized, nil
}

func writeSettlementsToMetadata(metadata map[string]interface{}, settlements []interface{}) {
	if metadata == nil {
		return
	}

	billingMap, ok := metadata[metadataKeyBilling].(map[string]interface{})
	if !ok || billingMap == nil {
		billingMap = make(map[string]interface{})
	}
	billingMap[metadataKeySettlements] = settlements
	metadata[metadataKeyBilling] = billingMap
}

func ensureSettlementCapacity(settlements []interface{}, requestIndex int) []interface{} {
	if requestIndex < 0 {
		return settlements
	}
	if len(settlements) > requestIndex {
		return settlements
	}
	expanded := make([]interface{}, requestIndex+1)
	copy(expanded, settlements)
	return expanded
}

func parseSettlementEntry(raw interface{}) (settlementEntry, error) {
	if raw == nil {
		return settlementEntry{}, nil
	}
	entryMap, ok := raw.(map[string]interface{})
	if !ok {
		return settlementEntry{}, fmt.Errorf("settlement entry is not an object")
	}
	entryBytes, err := json.Marshal(entryMap)
	if err != nil {
		return settlementEntry{}, fmt.Errorf("marshal settlement entry: %w", err)
	}
	var entry settlementEntry
	if err := json.Unmarshal(entryBytes, &entry); err != nil {
		return settlementEntry{}, fmt.Errorf("unmarshal settlement entry: %w", err)
	}
	return entry, nil
}

func (e settlementEntry) toMap() map[string]interface{} {
	raw, err := json.Marshal(e)
	if err != nil {
		// Marshal should never fail for this struct, but return minimal map defensively.
		return map[string]interface{}{
			"billing_user_id":              e.UserID,
			"billing_usage_event_id":       e.UsageEventID,
			"billing_consumption_group_id": e.ConsumptionGroupID,
			"billing_amount_millicredits":  e.AmountMillicredits,
			"billing_status":               e.Status,
			"billing_last_error":           e.LastError,
			"billing_retry_count":          e.RetryCount,
			"billing_updated_at":           e.UpdatedAt,
		}
	}
	out := make(map[string]interface{})
	_ = json.Unmarshal(raw, &out)
	return out
}

func (s *GenerationBillingStore) withTx(ctx context.Context, fn func(context.Context, pgx.Tx) error) error {
	if tx := postgres.GetTx(ctx); tx != nil {
		return fn(ctx, tx)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin generation billing transaction: %w", err)
	}
	defer func() {
		if rbErr := tx.Rollback(ctx); rbErr != nil && rbErr != pgx.ErrTxClosed {
			if s.logger != nil {
				s.logger.Error("generation billing rollback failed", "error", rbErr)
			}
		}
	}()

	txCtx := postgres.SetTx(ctx, tx)
	if err := fn(txCtx, tx); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit generation billing transaction: %w", err)
	}

	return nil
}
