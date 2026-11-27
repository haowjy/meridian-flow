import { type SubmissionLock, submissionLockName } from "../lock";

export const browserSubmissionLock: SubmissionLock = {
  run: (accountId, threadId, signal, operation) =>
    navigator.locks.request(submissionLockName(accountId, threadId), { signal }, operation),
};
