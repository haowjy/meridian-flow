// Provider authorship is immutable; edit scopes rotate at save boundaries.
export interface ModelResponseIdentity {
  readonly providerResponseId: string;
  readonly editScopeId: string;
}

/**
 * The response an edit is authored in. A held write also names its reply's scope; a model edit
 * that is a command has none.
 */
export type ResponseAuthorship = Pick<ModelResponseIdentity, "providerResponseId"> &
  Partial<ModelResponseIdentity>;
