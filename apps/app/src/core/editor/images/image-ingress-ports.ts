export type UploadedImage = {
  /**
   * The document's `src`, always a stable `asset:<documentId>`. A signed URL
   * expires and a web address is not the project's, so neither may be written.
   */
  src: string;
  alt: string | null;
};

/**
 * Send one image's bytes to the project.
 *
 * `id` is the upload's intake id, minted by the editor: sending again with it resumes. `signal`
 * aborts, because the writer taking a pending picture back is a cancellation and not a failure.
 * `onProgress` reports whole percents, or null where the browser cannot say how much there is.
 */
export type ImageUploadPort = (input: {
  id: string;
  file: File;
  alt: string;
  signal: AbortSignal;
  onProgress: (percent: number | null) => void;
}) => Promise<UploadedImage>;

export type ImageBytesPort = (input: {
  url: string;
  filename: string;
  signal: AbortSignal;
}) => Promise<File | null>;

export type ImageIngressHost = {
  upload: ImageUploadPort;
  fetchBytes: ImageBytesPort;
};
