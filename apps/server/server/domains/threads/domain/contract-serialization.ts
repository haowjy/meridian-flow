export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
