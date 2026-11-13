/**
 * The provider's own status and message, kept as owner-scoped debug evidence for
 * `./mf thread view`. Never enters event payloads or model context, and the app
 * never shows the message.
 */
export type ProviderErrorResponse = {
  /** HTTP status; null when the provider reported the failure inside the stream. */
  status: number | null;
  message: string;
};
