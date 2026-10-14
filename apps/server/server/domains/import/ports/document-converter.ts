/** DOCX conversion boundary, independent of planning/classification. */
export interface DocumentConverterPort {
  convert(bytes: Uint8Array): Promise<string>;
}
