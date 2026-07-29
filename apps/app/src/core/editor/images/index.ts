/** Public surface of the editor's image lane: ingress, pending state, assets. */
export { ImageIngressExtension } from "./ImageIngressExtension";
export { ImageNodeView } from "./ImageNodeView";
export type {
  ImageBytesPort,
  ImageIngressHost,
  ImageUploadPort,
  UploadedImage,
} from "./image-ingress-ports";
export {
  canUploadImages,
  editorAssetIndex,
  imageIngressStatus,
  pendingImages,
  registerImageIngressHost,
} from "./image-ingress-runtime";
export type { ImageIngressNotice, ImageIngressStatus } from "./image-ingress-store";
export {
  insertImageFile,
  openImagePicker,
  openImageReplacePicker,
  removePendingImage,
  replaceImageFile,
  retryPendingImage,
} from "./image-uploads";
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
  pendingImageSignature,
} from "./pending-images";
