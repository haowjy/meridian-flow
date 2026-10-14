/** The coordinator's HTTP seam, replaceable by a durable fake for workflow tests. */
import {
  acknowledgeImport,
  createImport,
  getImportDetail,
  listOpenImports,
  retryImport,
  sendImportFiles,
  skipImportFiles,
  stopImport,
} from "@/client/api/imports-api";
export const importApi = {
  create: createImport,
  send: sendImportFiles,
  skip: skipImportFiles,
  stop: stopImport,
  retry: retryImport,
  acknowledge: acknowledgeImport,
  detail: getImportDetail,
  listOpen: listOpenImports,
};
export type ImportApi = typeof importApi;
