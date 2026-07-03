/** In-memory DraftStore contract wiring — shared behavioral contract for fake adapters. */

import {
  DRAFT_STORE_CONTRACT_IDS,
  runDraftStoreContract,
} from "../__conformance__/draft-store-contract.js";
import { createInMemoryDraftStore } from "../adapters/in-memory/drafts.js";

runDraftStoreContract(() => {
  const store = createInMemoryDraftStore([
    [DRAFT_STORE_CONTRACT_IDS.threadId as never, DRAFT_STORE_CONTRACT_IDS.workId as never],
    [DRAFT_STORE_CONTRACT_IDS.peerThreadId as never, DRAFT_STORE_CONTRACT_IDS.workId as never],
  ]);
  return {
    store,
    expireAcceptClaim: async (draftId) => store.expireAcceptClaim(draftId),
    seedDraftScopedState: async (draftId) => store.seedDraftScopedState(draftId),
    countDraftScopedState: async (draftId) => store.countDraftScopedState(draftId),
  };
});
