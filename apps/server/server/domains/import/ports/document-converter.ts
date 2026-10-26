/** Input kinds the server organizer can convert into tracked text. */
export type ImportConvertibleFileKind = "markdown" | "text" | "docx" | "unsupported";

export type ConversionMessage = {
  type: "warning" | "info";
  message: string;
};

export type DocumentConversion = {
  markdown: string;
  messages: ConversionMessage[];
};

export interface DocumentConverterPort {
  classify(input: { filename: string; mimeType: string }): ImportConvertibleFileKind;
  convert(input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<DocumentConversion>;
}
