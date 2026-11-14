/** The response an edit is authored in. */
export interface ResponseAuthorship {
  /** The stored `model_responses` row's id, not an id the provider sent; it keys the response's commands. */
  readonly modelResponseId: string;
}
