export type CorpusImportFileKind = "markdown" | "text" | "docx" | "unsupported";

export type ConversionMessage = {
  type: "warning" | "info";
  message: string;
};

export type ConvertedDocument = {
  markdown: string;
  messages: ConversionMessage[];
};

export interface DocumentConverterPort {
  classify(input: { filename: string; mimeType: string }): CorpusImportFileKind;
  convert(input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<ConvertedDocument>;
}
