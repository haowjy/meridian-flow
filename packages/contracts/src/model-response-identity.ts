// Provider authorship is immutable; edit scopes rotate at save boundaries.
export interface ModelResponseIdentity {
  readonly providerResponseId: string;
  readonly editScopeId: string;
}
