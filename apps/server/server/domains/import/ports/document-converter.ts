export interface ConvertedImage {
  name: string;
  bytes: Uint8Array;
}

export interface ConvertedDocument {
  markdown: string;
  images: ConvertedImage[];
}

export interface DocumentConverterPort {
  convert(bytes: Uint8Array, imageFolder: string): Promise<ConvertedDocument>;
}
