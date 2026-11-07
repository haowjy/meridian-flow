/** The writer's words for a file over the upload limit. */
import { t } from "@lingui/core/macro";
import { MAX_UPLOAD_BYTES } from "@meridian/contracts/protocol";

const LIMIT_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);

export const fileTooLargeMessage = (name: string) =>
  t`${name} is over ${LIMIT_MB} MB, so it can't be added.`;

export const filesTooLargeMessage = () => t`Files over ${LIMIT_MB} MB can't be added.`;
