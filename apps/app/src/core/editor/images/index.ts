/**
 * What the rest of the app may ask of the editor's image lane.
 *
 * Six things, and no more: mount the two extensions, open a picture's door onto
 * a held target, put a picture the project already has into the prose, ask where
 * a picture may stand, register the app's ports, and read what ingress has to
 * say outside the document. Everything else — the pending record, the
 * decorations, the token, the upload lifecycle — is how this lane keeps those
 * promises, and a second vocabulary for it would be a second way to think about
 * a picture.
 *
 * `insertInlineImage` is the one door out: `@` names an asset that already
 * exists, and it must land the same object in the same place an upload does.
 *
 * The lane's own files import each other directly, and so do its tests.
 */

export { ImageIngressExtension } from "./ImageIngressExtension";
export type {
  ImageBytesPort,
  ImageIngressHost,
  ImageUploadPort,
  UploadedImage,
} from "./image-ingress-ports";
export {
  editorAssetIndex,
  imageIngressStatus,
  registerImageIngressHost,
} from "./image-ingress-runtime";
export type { ImageIngressStatus } from "./image-ingress-store";
export { type InlineImage, insertInlineImage } from "./image-insertion";
export { imageWidthAttr, setImageWidth } from "./image-resize";
export { ImageUploadPresenceExtension } from "./image-upload-presence";
export {
  type ImagePickerTarget,
  imageCaretTarget,
  imageReplaceTarget,
  openImagePicker,
} from "./image-uploads";
export {
  acceptsInlineImage,
  assetDocumentIdFromSrc,
  imageAltFromFilename,
  imageAttrsFromUpload,
  signedUrlRefreshDelayMs,
} from "./image-workflow";
