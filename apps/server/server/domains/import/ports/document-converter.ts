export interface DocumentConverterPort {
  convert(bytes: Uint8Array): Promise<string>;
}
