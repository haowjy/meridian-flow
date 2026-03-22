package billing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	billingmodel "meridian/internal/domain/models/billing"
	billingrepo "meridian/internal/domain/repositories/billing"
	"meridian/internal/repository/postgres"
)

type integrationHarness struct {
	store  billingrepo.CreditStore
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

func setupIntegrationHarness(t *testing.T) *integrationHarness {
	t.Helper()

	dbURL := os.Getenv("SUPABASE_DB_URL")
	if dbURL == "" {
		t.Skip("SUPABASE_DB_URL not set; skipping billing repository integration tests")
	}

	tablePrefix := os.Getenv("TABLE_PREFIX")
	if tablePrefix == "" {
		tablePrefix = "dev_"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := postgres.CreateConnectionPool(ctx, dbURL, 5, 1)
	if err != nil {
		t.Skipf("database unavailable for integration tests: %v", err)
	}
	t.Cleanup(pool.Close)

	tables := postgres.NewTableNames(tablePrefix)
	store := NewCreditStore(&postgres.RepositoryConfig{
		Pool:   pool,
		Tables: tables,
		Logger: slog.Default(),
	})

	return &integrationHarness{store: store, pool: pool, tables: tables}
}

func (h *integrationHarness) createTestUser(t *testing.T) string {
	t.Helper()

	userID := uuid.NewString()
	email := fmt.Sprintf("billing-int-%s@example.com", userID[:8])
	ctx := context.Background()

	minimalInsert := `
		INSERT INTO auth.users (
			id,
			aud,
			role,
			email,
			encrypted_password,
			email_confirmed_at,
			raw_app_meta_data,
			raw_user_meta_data,
			created_at,
			updated_at
		)
		VALUES (
			$1,
			'authenticated',
			'authenticated',
			$2,
			'not-used-in-tests',
			NOW(),
			'{}'::jsonb,
			'{}'::jsonb,
			NOW(),
			NOW()
		)
	`

	if _, err := h.pool.Exec(ctx, minimalInsert, userID, email); err != nil {
		fallbackInsert := `
			INSERT INTO auth.users (
				id,
				instance_id,
				aud,
				role,
				email,
				encrypted_password,
				email_confirmed_at,
				confirmation_token,
				recovery_token,
				email_change_token_new,
				email_change,
				raw_app_meta_data,
				raw_user_meta_data,
				created_at,
				updated_at
			)
			VALUES (
				$1,
				'00000000-0000-0000-0000-000000000000',
				'authenticated',
				'authenticated',
				$2,
				'not-used-in-tests',
				NOW(),
				'',
				'',
				'',
				'',
				'{}'::jsonb,
				'{}'::jsonb,
				NOW(),
				NOW()
			)
		`

		if _, fallbackErr := h.pool.Exec(ctx, fallbackInsert, userID, email); fallbackErr != nil {
			t.Skipf("unable to insert auth.users row for integration test: %v (fallback: %v)", err, fallbackErr)
		}
	}

	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(), `DELETE FROM auth.users WHERE id = $1`, userID)
	})

	return userID
}

func (h *integrationHarness) getLotIDByStripeSession(t *testing.T, stripeSessionID string) uuid.UUID {
	t.Helper()

	query := fmt.Sprintf(`SELECT id FROM %s WHERE stripe_session_id = $1`, h.tables.CreditLots)
	var lotID uuid.UUID
	if err := h.pool.QueryRow(context.Background(), query, stripeSessionID).Scan(&lotID); err != nil {
		t.Fatalf("query lot by stripe_session_id: %v", err)
	}
	return lotID
}

func (h *integrationHarness) getLotIDByGrantReason(t *testing.T, userID, grantReason string) uuid.UUID {
	t.Helper()

	query := fmt.Sprintf(`SELECT id FROM %s WHERE user_id = $1 AND grant_reason = $2`, h.tables.CreditLots)
	var lotID uuid.UUID
	if err := h.pool.QueryRow(context.Background(), query, userID, grantReason).Scan(&lotID); err != nil {
		t.Fatalf("query lot by grant_reason: %v", err)
	}
	return lotID
}

func (h *integrationHarness) countRows(t *testing.T, query string, args ...interface{}) int {
	t.Helper()

	var count int
	if err := h.pool.QueryRow(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatalf("count rows failed: %v", err)
	}
	return count
}

func TestCreditStore_CreatePurchaseLot_Idempotent(t *testing.T) {
	h := setupIntegrationHarness(t)
	userID := h.createTestUser(t)

	stripeSessionID := "cs_test_" + uuid.NewString()
	req := billingrepo.CreatePurchaseLotRequest{
		UserID:             userID,
		AmountMillicredits: 500_000,
		StripeSessionID:    stripeSessionID,
		Metadata:           map[string]interface{}{"source": "test"},
	}

	if err := h.store.CreatePurchaseLot(context.Background(), req); err != nil {
		t.Fatalf("first CreatePurchaseLot failed: %v", err)
	}
	if err := h.store.CreatePurchaseLot(context.Background(), req); err != nil {
		t.Fatalf("second CreatePurchaseLot failed: %v", err)
	}

	lotCountQuery := fmt.Sprintf(`SELECT COUNT(*) FROM %s WHERE stripe_session_id = $1`, h.tables.CreditLots)
	if got := h.countRows(t, lotCountQuery, stripeSessionID); got != 1 {
		t.Fatalf("purchase lot count = %d, want 1", got)
	}

	txnCountQuery := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE user_id = $1 AND transaction_type = 'purchase'
	`, h.tables.CreditTransactions)
	if got := h.countRows(t, txnCountQuery, userID); got != 1 {
		t.Fatalf("purchase transaction count = %d, want 1", got)
	}
}

func TestCreditStore_CreateGrantLot_Idempotent(t *testing.T) {
	h := setupIntegrationHarness(t)
	userID := h.createTestUser(t)

	expiresAt := time.Now().UTC().Add(24 * time.Hour)
	grantReason := "signup_bonus_test_" + uuid.NewString()
	req := billingrepo.CreateGrantLotRequest{
		UserID:             userID,
		AmountMillicredits: 300_000,
		ExpiresAt:          &expiresAt,
		GrantReason:        grantReason,
		Metadata:           map[string]interface{}{"source": "test"},
	}

	if err := h.store.CreateGrantLot(context.Background(), req); err != nil {
		t.Fatalf("first CreateGrantLot failed: %v", err)
	}
	if err := h.store.CreateGrantLot(context.Background(), req); !errors.Is(err, billingrepo.ErrGrantLotAlreadyExists) {
		t.Fatalf("second CreateGrantLot error = %v, want ErrGrantLotAlreadyExists", err)
	}

	lotCountQuery := fmt.Sprintf(`SELECT COUNT(*) FROM %s WHERE user_id = $1 AND grant_reason = $2`, h.tables.CreditLots)
	if got := h.countRows(t, lotCountQuery, userID, grantReason); got != 1 {
		t.Fatalf("grant lot count = %d, want 1", got)
	}

	txnCountQuery := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE user_id = $1 AND transaction_type = 'grant'
	`, h.tables.CreditTransactions)
	if got := h.countRows(t, txnCountQuery, userID); got != 1 {
		t.Fatalf("grant transaction count = %d, want 1", got)
	}
}

func TestCreditStore_RefundLot_ClawsBackSpentCreditsAndIsIdempotent(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()
	userID := h.createTestUser(t)

	stripeSessionID := "cs_refund_" + uuid.NewString()
	if err := h.store.CreatePurchaseLot(ctx, billingrepo.CreatePurchaseLotRequest{
		UserID:             userID,
		AmountMillicredits: 1000,
		StripeSessionID:    stripeSessionID,
	}); err != nil {
		t.Fatalf("CreatePurchaseLot failed: %v", err)
	}
	lotID := h.getLotIDByStripeSession(t, stripeSessionID)

	if err := h.store.ConsumeFIFO(ctx, billingrepo.ConsumeFIFORequest{
		UserID:             userID,
		AmountMillicredits: 600,
		ConsumptionGroupID: uuid.New(),
		UsageEventID:       "turn_refund_anchor:0",
	}); err != nil {
		t.Fatalf("ConsumeFIFO failed: %v", err)
	}

	if err := h.store.RefundLot(ctx, billingrepo.RefundLotRequest{
		StripeSessionID: stripeSessionID,
		Metadata:        map[string]interface{}{"source": "test"},
	}); err != nil {
		t.Fatalf("first RefundLot failed: %v", err)
	}
	if err := h.store.RefundLot(ctx, billingrepo.RefundLotRequest{
		StripeSessionID: stripeSessionID,
		Metadata:        map[string]interface{}{"source": "test"},
	}); err != nil {
		t.Fatalf("second RefundLot failed: %v", err)
	}

	balance, err := h.store.GetBalance(ctx, userID)
	if err != nil {
		t.Fatalf("GetBalance failed: %v", err)
	}
	if balance.TotalBalanceMillicredits != -600 {
		t.Fatalf("total balance = %d, want -600", balance.TotalBalanceMillicredits)
	}
	if balance.DebtBalanceMillicredits != 600 {
		t.Fatalf("debt balance = %d, want 600", balance.DebtBalanceMillicredits)
	}

	refundCountQuery := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE lot_id = $1 AND transaction_type = 'refund'
	`, h.tables.CreditTransactions)
	if got := h.countRows(t, refundCountQuery, lotID); got != 1 {
		t.Fatalf("refund transaction count = %d, want 1", got)
	}
}

func TestCreditStore_ConsumeFIFO_PromotionalBeforePurchased(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()
	userID := h.createTestUser(t)

	grantReason := "promo_fifo_" + uuid.NewString()
	expiresAt := time.Now().UTC().Add(48 * time.Hour)
	if err := h.store.CreateGrantLot(ctx, billingrepo.CreateGrantLotRequest{
		UserID:             userID,
		AmountMillicredits: 1_000,
		ExpiresAt:          &expiresAt,
		GrantReason:        grantReason,
		Metadata:           map[string]interface{}{"kind": "promo"},
	}); err != nil {
		t.Fatalf("CreateGrantLot failed: %v", err)
	}
	promoLotID := h.getLotIDByGrantReason(t, userID, grantReason)

	stripeSessionID := "cs_fifo_" + uuid.NewString()
	if err := h.store.CreatePurchaseLot(ctx, billingrepo.CreatePurchaseLotRequest{
		UserID:             userID,
		AmountMillicredits: 2_000,
		StripeSessionID:    stripeSessionID,
		Metadata:           map[string]interface{}{"kind": "purchase"},
	}); err != nil {
		t.Fatalf("CreatePurchaseLot failed: %v", err)
	}
	purchaseLotID := h.getLotIDByStripeSession(t, stripeSessionID)

	groupID := uuid.New()
	if err := h.store.ConsumeFIFO(ctx, billingrepo.ConsumeFIFORequest{
		UserID:             userID,
		AmountMillicredits: 1_500,
		ConsumptionGroupID: groupID,
		UsageEventID:       "turn_1:0",
		Metadata:           map[string]interface{}{"source": "test"},
	}); err != nil {
		t.Fatalf("ConsumeFIFO failed: %v", err)
	}

	query := fmt.Sprintf(`
		SELECT lot_id, -amount_millicredits
		FROM %s
		WHERE user_id = $1 AND consumption_group_id = $2
		ORDER BY created_at, id
	`, h.tables.CreditTransactions)
	rows, err := h.pool.Query(ctx, query, userID, groupID)
	if err != nil {
		t.Fatalf("query consumption rows: %v", err)
	}
	defer rows.Close()

	type row struct {
		lotID  uuid.UUID
		amount int64
	}
	var consumed []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.lotID, &r.amount); err != nil {
			t.Fatalf("scan consumption row: %v", err)
		}
		consumed = append(consumed, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate consumption rows: %v", err)
	}

	if len(consumed) != 2 {
		t.Fatalf("consumption rows = %d, want 2", len(consumed))
	}
	if consumed[0].lotID != promoLotID || consumed[0].amount != 1_000 {
		t.Fatalf("first consumption = (%s, %d), want (%s, 1000)", consumed[0].lotID, consumed[0].amount, promoLotID)
	}
	if consumed[1].lotID != purchaseLotID || consumed[1].amount != 500 {
		t.Fatalf("second consumption = (%s, %d), want (%s, 500)", consumed[1].lotID, consumed[1].amount, purchaseLotID)
	}
}

func TestCreditStore_ConsumeFIFO_IdempotentByConsumptionGroupID(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()
	userID := h.createTestUser(t)

	expiresAt := time.Now().UTC().Add(24 * time.Hour)
	if err := h.store.CreateGrantLot(ctx, billingrepo.CreateGrantLotRequest{
		UserID:             userID,
		AmountMillicredits: 2_000,
		ExpiresAt:          &expiresAt,
		GrantReason:        "idempotent_consume_" + uuid.NewString(),
	}); err != nil {
		t.Fatalf("CreateGrantLot failed: %v", err)
	}

	groupID := uuid.New()
	consumeReq := billingrepo.ConsumeFIFORequest{
		UserID:             userID,
		AmountMillicredits: 1_000,
		ConsumptionGroupID: groupID,
		UsageEventID:       "turn_2:0",
	}

	if err := h.store.ConsumeFIFO(ctx, consumeReq); err != nil {
		t.Fatalf("first ConsumeFIFO failed: %v", err)
	}
	if err := h.store.ConsumeFIFO(ctx, consumeReq); err != nil {
		t.Fatalf("second ConsumeFIFO failed: %v", err)
	}

	txnCountQuery := fmt.Sprintf(`SELECT COUNT(*) FROM %s WHERE consumption_group_id = $1`, h.tables.CreditTransactions)
	if got := h.countRows(t, txnCountQuery, groupID); got != 1 {
		t.Fatalf("consumption transaction count = %d, want 1", got)
	}

	balance, err := h.store.GetBalance(ctx, userID)
	if err != nil {
		t.Fatalf("GetBalance failed: %v", err)
	}
	if balance.TotalBalanceMillicredits != 1_000 {
		t.Fatalf("remaining balance = %d, want 1000", balance.TotalBalanceMillicredits)
	}
}

func TestCreditStore_ConsumeFIFO_NegativeAnchorAndMissingAnchorBehavior(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()

	anchoredUserID := h.createTestUser(t)
	if err := h.store.CreatePurchaseLot(ctx, billingrepo.CreatePurchaseLotRequest{
		UserID:             anchoredUserID,
		AmountMillicredits: 100,
		StripeSessionID:    "cs_anchor_" + uuid.NewString(),
	}); err != nil {
		t.Fatalf("CreatePurchaseLot failed: %v", err)
	}

	if err := h.store.ConsumeFIFO(ctx, billingrepo.ConsumeFIFORequest{
		UserID:             anchoredUserID,
		AmountMillicredits: 300,
		ConsumptionGroupID: uuid.New(),
		UsageEventID:       "turn_anchor:0",
	}); err != nil {
		t.Fatalf("ConsumeFIFO with anchor failed: %v", err)
	}

	anchoredBalance, err := h.store.GetBalance(ctx, anchoredUserID)
	if err != nil {
		t.Fatalf("GetBalance for anchored user failed: %v", err)
	}
	if anchoredBalance.TotalBalanceMillicredits != -200 {
		t.Fatalf("anchored total balance = %d, want -200", anchoredBalance.TotalBalanceMillicredits)
	}
	if anchoredBalance.DebtBalanceMillicredits != 200 {
		t.Fatalf("anchored debt balance = %d, want 200", anchoredBalance.DebtBalanceMillicredits)
	}

	emptyUserID := h.createTestUser(t)
	err = h.store.ConsumeFIFO(ctx, billingrepo.ConsumeFIFORequest{
		UserID:             emptyUserID,
		AmountMillicredits: 50,
		ConsumptionGroupID: uuid.New(),
		UsageEventID:       "turn_missing_anchor:0",
	})
	if err == nil {
		t.Fatal("expected ConsumeFIFO to fail for user with no anchor lot")
	}
	if !errors.Is(err, domain.ErrInsufficientCredits) {
		t.Fatalf("expected insufficient credits error, got: %v", err)
	}
}

func TestCreditStore_ConsumeFIFO_ExpiredLotCanAnchorFallback(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()
	userID := h.createTestUser(t)

	expiredAt := time.Now().UTC().Add(-10 * time.Minute)
	if err := h.store.CreateGrantLot(ctx, billingrepo.CreateGrantLotRequest{
		UserID:             userID,
		AmountMillicredits: 100,
		ExpiresAt:          &expiredAt,
		GrantReason:        "expired_anchor_" + uuid.NewString(),
	}); err != nil {
		t.Fatalf("CreateGrantLot failed: %v", err)
	}

	if err := h.store.ConsumeFIFO(ctx, billingrepo.ConsumeFIFORequest{
		UserID:             userID,
		AmountMillicredits: 50,
		ConsumptionGroupID: uuid.New(),
		UsageEventID:       "turn_expired_anchor:0",
	}); err != nil {
		t.Fatalf("ConsumeFIFO with expired anchor failed: %v", err)
	}
}

func TestCreditStore_ExpireAvailableLots_FiltersExpiredBalanceAndLogsTransactions(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()
	userID := h.createTestUser(t)

	pastExpiry := time.Now().UTC().Add(-2 * time.Hour)
	pastReason := "expired_lot_" + uuid.NewString()
	if err := h.store.CreateGrantLot(ctx, billingrepo.CreateGrantLotRequest{
		UserID:             userID,
		AmountMillicredits: 1_000,
		ExpiresAt:          &pastExpiry,
		GrantReason:        pastReason,
	}); err != nil {
		t.Fatalf("CreateGrantLot (expired) failed: %v", err)
	}
	pastLotID := h.getLotIDByGrantReason(t, userID, pastReason)

	futureExpiry := time.Now().UTC().Add(24 * time.Hour)
	if err := h.store.CreateGrantLot(ctx, billingrepo.CreateGrantLotRequest{
		UserID:             userID,
		AmountMillicredits: 2_000,
		ExpiresAt:          &futureExpiry,
		GrantReason:        "active_lot_" + uuid.NewString(),
	}); err != nil {
		t.Fatalf("CreateGrantLot (active) failed: %v", err)
	}

	balanceBefore, err := h.store.GetBalance(ctx, userID)
	if err != nil {
		t.Fatalf("GetBalance before expiration failed: %v", err)
	}
	if balanceBefore.TotalBalanceMillicredits != 2_000 || balanceBefore.PromotionalBalanceMillicredits != 2_000 {
		t.Fatalf("balance before expiration = %+v, want total=2000 promotional=2000", *balanceBefore)
	}

	nowUTC := time.Now().UTC().Format(time.RFC3339Nano)
	expired, err := h.store.ExpireAvailableLots(ctx, nowUTC, 10)
	if err != nil {
		t.Fatalf("ExpireAvailableLots failed: %v", err)
	}
	if len(expired) != 1 {
		t.Fatalf("expired lot count = %d, want 1", len(expired))
	}
	if expired[0].LotID != pastLotID || expired[0].AmountMillicredits != 1_000 {
		t.Fatalf("expired lot = (%s, %d), want (%s, 1000)", expired[0].LotID, expired[0].AmountMillicredits, pastLotID)
	}

	remainingQuery := fmt.Sprintf(`SELECT remaining_millicredits FROM %s WHERE id = $1`, h.tables.CreditLots)
	var remaining int64
	if err := h.pool.QueryRow(ctx, remainingQuery, pastLotID).Scan(&remaining); err != nil {
		t.Fatalf("query remaining after expiration: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("expired lot remaining = %d, want 0", remaining)
	}

	txnCountQuery := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE user_id = $1 AND lot_id = $2 AND transaction_type = 'expiration'
	`, h.tables.CreditTransactions)
	if got := h.countRows(t, txnCountQuery, userID, pastLotID); got != 1 {
		t.Fatalf("expiration transaction count = %d, want 1", got)
	}

	balanceAfter, err := h.store.GetBalance(ctx, userID)
	if err != nil {
		t.Fatalf("GetBalance after expiration failed: %v", err)
	}
	if balanceAfter.TotalBalanceMillicredits != 2_000 || balanceAfter.PromotionalBalanceMillicredits != 2_000 {
		t.Fatalf("balance after expiration = %+v, want total=2000 promotional=2000", *balanceAfter)
	}
}

func TestCreditStore_ListTransactions_Pagination(t *testing.T) {
	h := setupIntegrationHarness(t)
	ctx := context.Background()
	userID := h.createTestUser(t)

	for i := 0; i < 5; i++ {
		reason := fmt.Sprintf("pagination_%d_%s", i, uuid.NewString())
		expiresAt := time.Now().UTC().Add(48 * time.Hour)
		if err := h.store.CreateGrantLot(ctx, billingrepo.CreateGrantLotRequest{
			UserID:             userID,
			AmountMillicredits: int64(100 + i),
			ExpiresAt:          &expiresAt,
			GrantReason:        reason,
			Metadata:           map[string]interface{}{"i": i},
		}); err != nil {
			t.Fatalf("CreateGrantLot %d failed: %v", i, err)
		}
	}

	page, err := h.store.ListTransactions(ctx, userID, billingmodel.ListTransactionsRequest{Limit: 2, Offset: 1})
	if err != nil {
		t.Fatalf("ListTransactions failed: %v", err)
	}
	if page.Total != 5 {
		t.Fatalf("total = %d, want 5", page.Total)
	}
	if len(page.Items) != 2 {
		t.Fatalf("item count = %d, want 2", len(page.Items))
	}
	if page.Limit != 2 || page.Offset != 1 {
		t.Fatalf("pagination echo = (limit=%d, offset=%d), want (2,1)", page.Limit, page.Offset)
	}

	expectedQuery := fmt.Sprintf(`
		SELECT id::text
		FROM %s
		WHERE user_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT 2 OFFSET 1
	`, h.tables.CreditTransactions)
	expectedRows, err := h.pool.Query(ctx, expectedQuery, userID)
	if err != nil {
		t.Fatalf("query expected page ids failed: %v", err)
	}
	defer expectedRows.Close()

	expected := make([]string, 0, 2)
	for expectedRows.Next() {
		var id string
		if err := expectedRows.Scan(&id); err != nil {
			t.Fatalf("scan expected id failed: %v", err)
		}
		expected = append(expected, id)
	}
	if err := expectedRows.Err(); err != nil {
		t.Fatalf("iterate expected ids failed: %v", err)
	}

	if len(expected) != len(page.Items) {
		t.Fatalf("expected id count = %d, page item count = %d", len(expected), len(page.Items))
	}
	for i := range expected {
		if page.Items[i].ID.String() != expected[i] {
			t.Fatalf("page item %d id = %s, want %s", i, page.Items[i].ID.String(), expected[i])
		}
	}
}
