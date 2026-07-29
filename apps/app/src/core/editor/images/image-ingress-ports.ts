/**
 * What the editor needs from the app to bring a picture into a document.
 *
 * The editor knows a picture is arriving, where it goes, and what it looks
 * like while it travels. It does not know the project, the figure endpoint, or
 * how bytes reach storage — those are the app's, so they arrive as ports the
 * app registers on the running editor (`registerImageIngressHost`). Until one
 * registers, the ingress refuses every entry out loud rather than opening a
 * picker that leads nowhere (law 5).
 */

/** What an upload gives back: the ref the document holds, and where it lives. */
export type UploadedImage = {
  /**
   * The document's `src`, always a stable `asset:<documentId>`. A signed URL
   * expires and a web address is not the project's, so neither may be written.
   */
  src: string;
  alt: string | null;
  assetDocumentId: string;
  /** Project-relative path, which is how an asset travels on the clipboard. */
  assetPath: string;
};

/**
 * Send one image's bytes to the project.
 *
 * `signal` aborts, because the writer deleting a pending picture is a
 * cancellation and not a failure. `onProgress` reports whole percents, or null
 * where the browser cannot say how much there is to send.
 */
export type ImageUploadPort = (input: {
  file: File;
  alt: string;
  signal: AbortSignal;
  onProgress: (percent: number | null) => void;
}) => Promise<UploadedImage>;

/**
 * The bytes behind an address the clipboard carried, or null when the browser
 * will not hand them over.
 *
 * Null is the ordinary answer, not an error: most of the web serves images
 * without the CORS headers a fetch would need, and the link the paste already
 * landed is what the writer keeps in that case.
 */
export type ImageBytesPort = (input: {
  url: string;
  filename: string;
  signal: AbortSignal;
}) => Promise<File | null>;

/** The app's half of image ingress, registered once per mounted editor. */
export type ImageIngressHost = {
  upload: ImageUploadPort;
  fetchBytes: ImageBytesPort;
};
