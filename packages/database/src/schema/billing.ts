import type { CreditLotId, CreditTransactionId, UserId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  pgView,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, jsonbDefault, millicredits } from "./_shared";
import { users } from "./users";

export const creditLots = pgTable(
  "credit_lots",
  {
    id: idColumn<CreditLotId>(),
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    originalAmountMillicredits: millicredits("original_amount_millicredits").notNull(),
    remainingMillicredits: millicredits("remaining_millicredits").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    stripeSessionId: text("stripe_session_id"),
    grantReason: text("grant_reason"),
    metadata: jsonbDefault("metadata"),
    createdAt: createdAt(),
  },
  (table) => [
    check("credit_lots_original_positive", sql`${table.originalAmountMillicredits} > 0`),
    uniqueIndex("credit_lots_stripe_session")
      .on(table.stripeSessionId)
      .where(sql`${table.stripeSessionId} IS NOT NULL`),
    uniqueIndex("credit_lots_signup_grant")
      .on(table.userId, table.grantReason)
      .where(sql`${table.grantReason} = 'signup'`),
    uniqueIndex("credit_lots_monthly_grant")
      .on(table.userId, table.grantReason)
      .where(sql`${table.grantReason} LIKE 'monthly_%'`),
    uniqueIndex("credit_lots_free_tier_grant")
      .on(table.userId, table.grantReason)
      .where(sql`${table.sourceType} = 'grant' AND ${table.grantReason} LIKE 'free_tier_%'`),
    uniqueIndex("credit_lots_subscription_reason")
      .on(table.userId, table.grantReason)
      .where(sql`${table.sourceType} = 'subscription' AND ${table.grantReason} IS NOT NULL`),
    index("credit_lots_fifo_spend")
      .on(table.userId, table.expiresAt.asc().nullsLast(), table.createdAt, table.id)
      .where(sql`${table.remainingMillicredits} > 0`),
    uniqueIndex("credit_lots_debt_user").on(table.userId).where(sql`${table.sourceType} = 'debt'`),
    check(
      "credit_lots_source_type",
      sql`${table.sourceType} IN ('purchase', 'grant', 'subscription', 'debt')`,
    ),
    check(
      "credit_lots_purchase_stripe",
      sql`${table.sourceType} = 'purchase' OR ${table.stripeSessionId} IS NULL`,
    ),
    check(
      "credit_lots_grant_reason",
      sql`${table.sourceType} IN ('grant', 'subscription') OR ${table.grantReason} IS NULL`,
    ),
  ],
);

export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: idColumn<CreditTransactionId>(),
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    transactionType: text("transaction_type").notNull(),
    amountMillicredits: millicredits("amount_millicredits").notNull(),
    lotId: uuid("lot_id")
      .$type<CreditLotId>()
      .references(() => creditLots.id, {
        onDelete: "set null",
      }),
    consumptionGroupId: uuid("consumption_group_id"),
    usageEventId: text("usage_event_id"),
    metadata: jsonbDefault("metadata"),
    createdAt: createdAt(),
  },
  (table) => [
    check("credit_transactions_nonzero", sql`${table.amountMillicredits} != 0`),
    check(
      "credit_transactions_transaction_type_valid",
      sql`${table.transactionType} IN ('purchase', 'grant', 'consumption', 'expiration', 'refund')`,
    ),
    check(
      "credit_transactions_consumption_group",
      sql`${table.transactionType} != 'consumption' OR ${table.consumptionGroupId} IS NOT NULL`,
    ),
    check(
      "credit_transactions_consumption_usage_event",
      sql`${table.transactionType} != 'consumption' OR ${table.usageEventId} IS NOT NULL`,
    ),
    index("credit_transactions_user_created").on(table.userId, table.createdAt.desc()),
    index("credit_transactions_consumption_group")
      .on(table.consumptionGroupId)
      .where(sql`${table.consumptionGroupId} IS NOT NULL`),
  ],
);

export const creditBalances = pgView("credit_balances").as((qb) => {
  const lots = creditLots;
  return qb
    .select({
      userId: lots.userId,
      totalBalanceMillicredits: sql<number>`COALESCE(SUM(${lots.remainingMillicredits}), 0)`.as(
        "total_balance_millicredits",
      ),
      grantBalanceMillicredits:
        sql<number>`COALESCE(SUM(${lots.remainingMillicredits}) FILTER (WHERE ${lots.sourceType} = 'grant'), 0)`.as(
          "grant_balance_millicredits",
        ),
      purchasedBalanceMillicredits:
        sql<number>`COALESCE(SUM(${lots.remainingMillicredits}) FILTER (WHERE ${lots.sourceType} = 'purchase'), 0)`.as(
          "purchased_balance_millicredits",
        ),
      debtBalanceMillicredits:
        sql<number>`COALESCE(SUM(${lots.remainingMillicredits}) FILTER (WHERE ${lots.sourceType} = 'debt'), 0)`.as(
          "debt_balance_millicredits",
        ),
    })
    .from(lots)
    .where(
      sql`${lots.expiresAt} IS NULL OR ${lots.expiresAt} > NOW() OR ${lots.sourceType} = 'debt'`,
    )
    .groupBy(lots.userId);
});
