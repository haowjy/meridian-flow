export type CreditLedger = {
  readonly phase: "skeleton";
};

export function createInMemoryCreditLedger(): CreditLedger {
  return { phase: "skeleton" };
}

export function createDrizzleCreditLedger(_db: unknown): CreditLedger {
  return createInMemoryCreditLedger();
}
