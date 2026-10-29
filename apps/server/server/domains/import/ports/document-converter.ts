/** An embedded image pulled out of a converted document; `name` is the file the Markdown links to. */
export interface ConvertedImage {
  name: string;
  bytes: Uint8Array;
}

/** Markdown whose image links read `<imageFolder>/<image.name>` relative to the document. */
export interface ConvertedDocument {
  markdown: string;
  images: ConvertedImage[];
}

export interface DocumentConverterPort {
  convert(bytes: Uint8Array, imageFolder: string): Promise<ConvertedDocument>;
}
