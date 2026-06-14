/**
 * Purpose: Minimal local pg typings for Playwright e2e seed scripts.
 * Key decision: pg is root test tooling; this declaration covers only the Client methods the e2e smoke uses.
 */
declare module "pg" {
  export class Client {
    constructor(config?: { connectionString?: string });
    connect(): Promise<void>;
    end(): Promise<void>;
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[] }>;
  }
}
