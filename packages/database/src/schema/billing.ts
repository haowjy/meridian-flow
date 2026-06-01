import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  pgView,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, jsonbDefault, millicredits, updatedAt } from "./_shared";
import { authUsers } from "./auth";

export const userSubscriptions = pgTable(
  "user_subscriptions",
  {
    id: idColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    plan: text("plan").notNull().default("pro"),
    status: text("status").notNull(),
    creditsPerPeriod: millicredits("credits_per_period").notNull(),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
    }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("user_subscriptions_active_user")
      .on(table.userId)
      .where(sql`${table.status} IN ('active', 'past_due', 'trialing')`),
    index("user_subscriptions_stripe_customer").on(table.stripeCustomerId),
  ],
);

export const creditLots = pgTable(
  "credit_lots",
  {
    id: idColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
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
      sql`${table.sourceType} = 'grant' OR ${table.grantReason} IS NULL`,
    ),
  ],
);

export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: idColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    transactionType: text("transaction_type").notNull(),
    amountMillicredits: millicredits("amount_millicredits").notNull(),
    lotId: uuid("lot_id").references(() => creditLots.id, { onDelete: "set null" }),
    consumptionGroupId: uuid("consumption_group_id"),
    usageEventId: text("usage_event_id"),
    metadata: jsonbDefault("metadata"),
    createdAt: createdAt(),
  },
  (table) => [
    check("credit_transactions_nonzero", sql`${table.amountMillicredits} != 0`),
    check(
      "credit_transactions_consumption_group",
      sql`${table.transactionType} != 'consumption' OR ${table.consumptionGroupId} IS NOT NULL`,
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
