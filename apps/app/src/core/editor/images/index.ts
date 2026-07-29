/** Public surface of the editor's image lane: ingress, pending state, assets. */
export {
  canUploadImages,
  editorAssetIndex,
  ImageIngressExtension,
  imageIngressStatus,
  insertImageFile,
  openImagePicker,
  pendingImages,
  registerImageIngressHost,
  removePendingImage,
  retryPendingImage,
} from "./ImageIngressExtension";
export type {
  ImageBytesPort,
  ImageIngressHost,
  ImageUploadPort,
  UploadedImage,
} from "./image-ingress-ports";
export type { ImageIngressNotice, ImageIngressStatus } from "./image-ingress-store";
export {
  assetDocumentIdFromSrc,
  createEditorAssetPathResolver,
  imageAltFromFilename,
  imageAttrsFromUpload,
  imageFilenameFromUrl,
  isImageFile,
  type MutableAssetPathResolver,
  resolveAssetRefsForClipboard,
  signedUrlRefreshDelayMs,
} from "./image-workflow";
export {
  IMPORTING_LINK_CLASS,
  PENDING_IMAGE_SRC,
  type PendingImage,
  type PendingImageUpload,
  pendingImageFromDecorations,
} from "./pending-images";
