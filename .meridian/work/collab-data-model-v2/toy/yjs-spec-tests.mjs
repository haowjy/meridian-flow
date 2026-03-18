import * as Y from '../../../../frontend/node_modules/yjs/src/index.js'

const ORIGIN_HUMAN = 'human'
const ORIGIN_ACCEPT = 'accept'
const ORIGIN_REJECT = 'reject'
const ORIGIN_GC = 'gc'
const ORIGIN_THREAD = 'thread'

const TRACKED_ORIGINS = new Set([
  ORIGIN_HUMAN,
  ORIGIN_ACCEPT,
  ORIGIN_REJECT,
  ORIGIN_THREAD
])

const INITIAL_TEXT = 'The cat sat on the mat.'
let nextClientID = 1
const YJS_CLIENT_ID_WARNING = 'Changed the client-id because another client seems to be using it.'

const filterKnownYjsWarning = write => (...args) => {
  const rendered = args.map(arg => String(arg)).join(' ')
  if (rendered.includes(YJS_CLIENT_ID_WARNING)) {
    return
  }
  write(...args)
}

console.log = filterKnownYjsWarning(console.log.bind(console))
console.warn = filterKnownYjsWarning(console.warn.bind(console))

const quote = value => `"${value}"`
const formatStatus = value => (value === undefined ? 'undefined' : String(value))

const createDoc = () => {
  const doc = new Y.Doc()
  doc.clientID = nextClientID++
  return doc
}

const setupDoc = (initialText = INITIAL_TEXT) => {
  const doc = createDoc()
  const text = doc.getText('content')
  const statusMap = doc.getMap('_proposal_status')
  text.insert(0, initialText)
  const undoManager = new Y.UndoManager([text, statusMap], {
    trackedOrigins: new Set(TRACKED_ORIGINS)
  })
  undoManager.clear()
  return { doc, text, statusMap, undoManager }
}

const cloneDoc = sourceDoc => {
  const clone = createDoc()
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(sourceDoc))
  return clone
}

const separateUndoStep = undoManager => {
  undoManager.stopCapturing()
}

const appendText = (textType, inserted) => {
  textType.insert(textType.length, inserted)
}

const insertBefore = (textType, needle, inserted) => {
  const current = textType.toString()
  const index = current.indexOf(needle)
  if (index < 0) {
    throw new Error(`Could not find ${quote(needle)} in ${quote(current)}`)
  }
  textType.insert(index, inserted)
  return index
}

const replaceFirst = (textType, target, replacement) => {
  const current = textType.toString()
  const index = current.indexOf(target)
  if (index < 0) {
    throw new Error(`Could not find ${quote(target)} in ${quote(current)}`)
  }
  textType.delete(index, target.length)
  if (replacement.length > 0) {
    textType.insert(index, replacement)
  }
  return index
}

const createProposal = (canonicalDoc, {
  id,
  edit,
  regionTextBefore,
  regionTextAfter,
  proposedAtOffset,
  createdByUserID = 'toy-user'
}) => {
  const clone = cloneDoc(canonicalDoc)
  const baseText = clone.getText('content').toString()
  let capturedUpdate = null
  clone.on('update', update => {
    capturedUpdate = capturedUpdate === null ? update : Y.mergeUpdates([capturedUpdate, update])
  })
  const maybeOffset = edit(clone.getText('content'), clone.getMap('_proposal_status'), clone)
  if (capturedUpdate === null) {
    throw new Error(`Proposal ${id} did not emit a Yjs update`)
  }
  return {
    id,
    created_by_user_id: createdByUserID,
    yjs_update: capturedUpdate,
    region_text_before: regionTextBefore,
    region_text_after: regionTextAfter,
    proposed_at_offset: typeof proposedAtOffset === 'number'
      ? proposedAtOffset
      : (typeof maybeOffset === 'number' ? maybeOffset : baseText.indexOf(regionTextBefore))
  }
}

const createBlackProposal = (canonicalDoc, id = 'p1') => createProposal(canonicalDoc, {
  id,
  edit: text => {
    insertBefore(text, 'cat', 'black ')
  },
  regionTextBefore: 'The cat',
  regionTextAfter: 'The black cat'
})

const createBigProposal = (canonicalDoc, id = 'p2') => createProposal(canonicalDoc, {
  id,
  edit: text => {
    insertBefore(text, 'cat', 'big ')
  },
  regionTextBefore: 'The cat',
  regionTextAfter: 'The big cat'
})

const createRugProposal = (canonicalDoc, id = 'p2') => createProposal(canonicalDoc, {
  id,
  edit: text => {
    replaceFirst(text, 'mat', 'rug')
  },
  regionTextBefore: 'mat',
  regionTextAfter: 'rug'
})

const createDoubleEditProposal = (canonicalDoc, id = 'p3') => createProposal(canonicalDoc, {
  id,
  edit: text => {
    const offset = insertBefore(text, 'cat', 'black ')
    replaceFirst(text, 'mat', 'rug')
    return offset
  },
  regionTextBefore: 'The cat sat on the mat.',
  regionTextAfter: 'The black cat sat on the rug.'
})

const createDeleteMatProposal = (canonicalDoc, id = 'p4') => createProposal(canonicalDoc, {
  id,
  edit: text => {
    replaceFirst(text, 'mat', '')
  },
  regionTextBefore: 'mat',
  regionTextAfter: ''
})

const acceptProposal = (env, proposal) => {
  env.doc.transact(() => {
    Y.applyUpdate(env.doc, proposal.yjs_update)
    env.statusMap.set(proposal.id, 'accepted')
  }, ORIGIN_ACCEPT)
}

const rejectProposal = (env, proposalId) => {
  env.doc.transact(() => {
    env.statusMap.set(proposalId, 'rejected')
  }, ORIGIN_REJECT)
}

const threadUndo = (env, proposal) => {
  env.doc.transact(() => {
    replaceFirst(env.text, proposal.region_text_after, proposal.region_text_before)
    env.statusMap.set(proposal.id, 'reverted')
  }, ORIGIN_THREAD)
}

const threadReapply = (env, proposal) => {
  env.doc.transact(() => {
    replaceFirst(env.text, proposal.region_text_before, proposal.region_text_after)
    env.statusMap.set(proposal.id, 'accepted')
  }, ORIGIN_THREAD)
}

const getStatus = (statusMap, id) => statusMap.get(id) || 'pending'

const isTerminalStatus = status => (
  status === 'accepted' || status === 'rejected' || status === 'reverted' || status === 'invalid'
)

const computeDiffSegments = (a, b) => {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const ops = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ t: 'eq', c: a[i - 1] })
      i -= 1
      j -= 1
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ t: 'ins', c: b[j - 1] })
      j -= 1
    } else {
      ops.unshift({ t: 'del', c: a[i - 1] })
      i -= 1
    }
  }

  const merged = []
  for (const op of ops) {
    if (merged.length > 0 && merged[merged.length - 1].t === op.t) {
      merged[merged.length - 1].s += op.c
    } else {
      merged.push({ t: op.t, s: op.c })
    }
  }
  return merged
}

const diffSegmentsToHunks = segments => {
  const hunks = []
  let canonicalPos = 0
  let pending = null

  const flush = () => {
    if (!pending) return
    hunks.push({
      canonicalRange: { from: pending.from, to: pending.to },
      deletedText: pending.deletedText,
      insertedText: pending.insertedText
    })
    pending = null
  }

  for (const segment of segments) {
    if (segment.t === 'eq') {
      flush()
      canonicalPos += segment.s.length
      continue
    }
    if (!pending) {
      pending = { from: canonicalPos, to: canonicalPos, deletedText: '', insertedText: '' }
    }
    if (segment.t === 'del') {
      pending.deletedText += segment.s
      canonicalPos += segment.s.length
      pending.to = canonicalPos
    } else {
      pending.insertedText += segment.s
    }
  }
  flush()
  return hunks
}

const textDiff = (canonicalText, projectedText) => {
  const segments = computeDiffSegments(canonicalText, projectedText)
  return { segments, hunks: diffSegmentsToHunks(segments) }
}

const rangesOverlap = (a, b) => {
  const aLen = a.to - a.from
  const bLen = b.to - b.from
  if (aLen === 0 && bLen === 0) return a.from === b.from
  if (aLen === 0) return b.from <= a.from && a.from <= b.to
  if (bLen === 0) return a.from <= b.from && b.from <= a.to
  return a.from < b.to && b.from < a.to
}

const shareAnyProposal = (a, b) => {
  const ids = new Set(a.proposals.map(p => p.id))
  return b.proposals.some(p => ids.has(p.id))
}

const stalePrecheck = (canonicalText, proposal) => {
  if (typeof proposal.proposed_at_offset !== 'number' || proposal.proposed_at_offset < 0) return false
  if (!proposal.region_text_after || proposal.region_text_after.length === 0) return false
  const start = proposal.proposed_at_offset
  const end = start + proposal.region_text_after.length
  return canonicalText.slice(start, end) === proposal.region_text_after
}

const makeUnionFind = size => {
  const parent = Array.from({ length: size }, (_, i) => i)
  const rank = Array.from({ length: size }, () => 0)
  const find = i => {
    if (parent[i] !== i) parent[i] = find(parent[i])
    return parent[i]
  }
  const unite = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    if (rank[ra] < rank[rb]) parent[ra] = rb
    else if (rank[ra] > rank[rb]) parent[rb] = ra
    else {
      parent[rb] = ra
      rank[ra] += 1
    }
  }
  return { find, unite }
}

const groupHunks = (attributedHunks, sequenceNumber) => {
  if (attributedHunks.length === 0) return []
  const uf = makeUnionFind(attributedHunks.length)
  for (let i = 0; i < attributedHunks.length; i += 1) {
    for (let j = i + 1; j < attributedHunks.length; j += 1) {
      const hi = attributedHunks[i]
      const hj = attributedHunks[j]
      if (rangesOverlap(hi.canonicalRange, hj.canonicalRange) || shareAnyProposal(hi, hj)) {
        uf.unite(i, j)
      }
    }
  }

  const byRoot = new Map()
  for (let i = 0; i < attributedHunks.length; i += 1) {
    const root = uf.find(i)
    const list = byRoot.get(root) || []
    list.push(attributedHunks[i])
    byRoot.set(root, list)
  }

  const grouped = []
  for (const members of byRoot.values()) {
    members.sort((a, b) => a.canonicalRange.from - b.canonicalRange.from)
    const proposalByID = new Map()
    let from = members[0].canonicalRange.from
    let to = members[0].canonicalRange.to
    for (const member of members) {
      from = Math.min(from, member.canonicalRange.from)
      to = Math.max(to, member.canonicalRange.to)
      for (const proposalRef of member.proposals) {
        proposalByID.set(proposalRef.id, proposalRef)
      }
    }
    grouped.push({
      proposals: Array.from(proposalByID.values()),
      canonicalRange: { from, to },
      insertedText: members.map(m => m.insertedText).join(''),
      deletedText: members.map(m => m.deletedText).join(''),
      sequenceNumber
    })
  }

  grouped.sort((a, b) => a.canonicalRange.from - b.canonicalRange.from)
  return grouped
}

const applyGC = (env, staleIDs, unstaleIDs) => {
  if (staleIDs.length === 0 && unstaleIDs.length === 0) return
  env.doc.transact(() => {
    for (const id of staleIDs) env.statusMap.set(id, 'stale')
    for (const id of unstaleIDs) env.statusMap.delete(id)
  }, ORIGIN_GC)
}

const deriveProjectionPipeline = (env, proposalRows, sequenceNumber = 1) => {
  let canonicalText = env.text.toString()
  const mutable = proposalRows.filter(p => !isTerminalStatus(getStatus(env.statusMap, p.id)))

  const staleByPrecheck = []
  const unstaleIDs = []
  for (const proposal of mutable) {
    const status = getStatus(env.statusMap, proposal.id)
    const precheck = stalePrecheck(canonicalText, proposal)
    if (status === 'pending' && precheck) staleByPrecheck.push(proposal.id)
    if (status === 'stale' && !precheck) unstaleIDs.push(proposal.id)
  }
  applyGC(env, staleByPrecheck, unstaleIDs)

  canonicalText = env.text.toString()
  const pending = proposalRows.filter(p => getStatus(env.statusMap, p.id) === 'pending')
  const projection = cloneDoc(env.doc)
  for (const proposal of pending) {
    Y.applyUpdate(projection, proposal.yjs_update)
  }
  const projectedText = projection.getText('content').toString()
  const combined = textDiff(canonicalText, projectedText)

  const proposalRegions = new Map()
  const staleByEmptyAttribution = []
  for (const proposal of pending) {
    const solo = cloneDoc(env.doc)
    Y.applyUpdate(solo, proposal.yjs_update)
    const soloText = solo.getText('content').toString()
    const soloDiff = textDiff(canonicalText, soloText)
    proposalRegions.set(proposal.id, soloDiff.hunks)
    if (soloDiff.hunks.length === 0) staleByEmptyAttribution.push(proposal.id)
  }
  applyGC(env, staleByEmptyAttribution, [])

  const pendingForAttribution = pending.filter(p => !staleByEmptyAttribution.includes(p.id))
  const attributed = combined.hunks.map(h => ({ ...h, proposals: [] }))
  for (const proposal of pendingForAttribution) {
    const regions = proposalRegions.get(proposal.id) || []
    const ref = { id: proposal.id, yjs_update: proposal.yjs_update }
    for (const hunk of attributed) {
      if (regions.some(region => rangesOverlap(region.canonicalRange, hunk.canonicalRange))) {
        hunk.proposals.push(ref)
      }
    }
  }

  return {
    hunks: groupHunks(attributed, sequenceNumber),
    sequenceNumber,
    canonicalText,
    projectedText,
    staleByPrecheck,
    unstaleIDs,
    staleByEmptyAttribution
  }
}

const toBase64 = update => Buffer.from(update).toString('base64')

const buildParityFixture = () => {
  const env = setupDoc()
  const p1 = createBlackProposal(env.doc, 'p1')
  const p2 = createRugProposal(env.doc, 'p2')
  const result = deriveProjectionPipeline(env, [p1, p2], 99)
  return {
    canonical_text: env.text.toString(),
    projected_text: result.projectedText,
    proposals: [p1, p2].map(p => ({
      id: p.id,
      yjs_update_base64: toBase64(p.yjs_update),
      region_text_before: p.region_text_before,
      region_text_after: p.region_text_after,
      proposed_at_offset: p.proposed_at_offset
    }))
  }
}

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${quote(String(expected))}, got ${quote(String(actual))}`)
  }
}

const assertStatus = (statusMap, id, expected, message) => {
  assertEqual(statusMap.get(id), expected, message)
}

const tests = [
  {
    name: 'Accept proposal -> Ctrl-Z restores text AND status',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      detail(`canonical: ${quote(env.text.toString())}`)
      acceptProposal(env, proposal)
      detail(`after accept: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)
      assertEqual(env.text.toString(), 'The black cat sat on the mat.', 'Accept should apply proposal text')
      assertStatus(env.statusMap, proposal.id, 'accepted', 'Accept should mark status accepted')

      env.undoManager.undo()
      detail(`after undo: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)
      assertEqual(env.text.toString(), INITIAL_TEXT, 'Undo should restore canonical text')
      assertStatus(env.statusMap, proposal.id, undefined, 'Undo should restore status to pending (missing key)')
    }
  },
  {
    name: 'Reject proposal -> Ctrl-Z restores status to pending',
    run: detail => {
      const env = setupDoc()
      const proposalId = 'p1'

      detail(`canonical: ${quote(env.text.toString())}`)
      rejectProposal(env, proposalId)
      detail(`after reject: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposalId))}`)
      assertEqual(env.text.toString(), INITIAL_TEXT, 'Reject should not change text')
      assertStatus(env.statusMap, proposalId, 'rejected', 'Reject should mark status rejected')

      env.undoManager.undo()
      detail(`after undo: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposalId))}`)
      assertEqual(env.text.toString(), INITIAL_TEXT, 'Undoing reject should leave text unchanged')
      assertStatus(env.statusMap, proposalId, undefined, 'Undoing reject should delete the key')
    }
  },
  {
    name: 'Thread undo (accepted -> reverted) via text search-and-replace',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      acceptProposal(env, proposal)
      separateUndoStep(env.undoManager)
      threadUndo(env, proposal)

      detail(`after accept: ${quote('The black cat sat on the mat.')} status=accepted`)
      detail(`after thread undo: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)
      assertEqual(env.text.toString(), INITIAL_TEXT, 'Thread undo should restore original text')
      assertStatus(env.statusMap, proposal.id, 'reverted', 'Thread undo should mark proposal reverted')
    }
  },
  {
    name: 'Ctrl-Z of thread undo (reverted -> accepted)',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      acceptProposal(env, proposal)
      separateUndoStep(env.undoManager)
      threadUndo(env, proposal)
      detail(`before undo: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)

      env.undoManager.undo()
      detail(`after undo: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)
      assertEqual(env.text.toString(), 'The black cat sat on the mat.', 'Undoing thread undo should restore accepted text')
      assertStatus(env.statusMap, proposal.id, 'accepted', 'Undoing thread undo should restore accepted status')
    }
  },
  {
    name: 'Thread reapply from reverted (reverted -> accepted)',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      acceptProposal(env, proposal)
      separateUndoStep(env.undoManager)
      threadUndo(env, proposal)
      separateUndoStep(env.undoManager)
      threadReapply(env, proposal)

      detail(`after reapply: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)
      assertEqual(env.text.toString(), 'The black cat sat on the mat.', 'Thread reapply should restore accepted text')
      assertStatus(env.statusMap, proposal.id, 'accepted', 'Thread reapply should restore accepted status')
    }
  },
  {
    name: 'Thread reapply from rejected (rejected -> accepted)',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      rejectProposal(env, proposal.id)
      separateUndoStep(env.undoManager)
      threadReapply(env, proposal)

      detail(`after reject: ${quote(INITIAL_TEXT)} status=rejected`)
      detail(`after reapply: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)
      assertEqual(env.text.toString(), 'The black cat sat on the mat.', 'Thread reapply from rejected should apply text')
      assertStatus(env.statusMap, proposal.id, 'accepted', 'Thread reapply from rejected should mark accepted')
    }
  },
  {
    name: 'Ctrl-Z of thread reapply from rejected (accepted -> rejected)',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      rejectProposal(env, proposal.id)
      separateUndoStep(env.undoManager)
      threadReapply(env, proposal)
      detail(`before undo: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)

      env.undoManager.undo()
      detail(`after undo: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)
      assertEqual(env.text.toString(), INITIAL_TEXT, 'Undoing thread reapply from rejected should remove text')
      assertStatus(env.statusMap, proposal.id, 'rejected', 'Undoing thread reapply from rejected should restore rejected status')
    }
  },
  {
    name: 'Interleaved undo stack: accept, type, reject, then undo sequence',
    run: detail => {
      const env = setupDoc()
      const p1 = createBlackProposal(env.doc, 'p1')
      const p2 = createRugProposal(env.doc, 'p2')

      acceptProposal(env, p1)
      separateUndoStep(env.undoManager)
      env.doc.transact(() => {
        appendText(env.text, ' hello')
      }, ORIGIN_HUMAN)
      separateUndoStep(env.undoManager)
      rejectProposal(env, p2.id)

      detail(`after actions: ${quote(env.text.toString())} p1=${formatStatus(env.statusMap.get(p1.id))} p2=${formatStatus(env.statusMap.get(p2.id))}`)
      assertEqual(env.undoManager.undoStack.length, 3, 'Expected three distinct undo steps')

      env.undoManager.undo()
      detail(`after undo 1: ${quote(env.text.toString())} p1=${formatStatus(env.statusMap.get(p1.id))} p2=${formatStatus(env.statusMap.get(p2.id))}`)
      assertEqual(env.text.toString(), 'The black cat sat on the mat. hello', 'Undo 1 should only revert reject status')
      assertStatus(env.statusMap, p2.id, undefined, 'Undo 1 should restore P2 to pending')

      env.undoManager.undo()
      detail(`after undo 2: ${quote(env.text.toString())} p1=${formatStatus(env.statusMap.get(p1.id))} p2=${formatStatus(env.statusMap.get(p2.id))}`)
      assertEqual(env.text.toString(), 'The black cat sat on the mat.', 'Undo 2 should remove human typing')
      assertStatus(env.statusMap, p1.id, 'accepted', 'Undo 2 should preserve accepted P1')

      env.undoManager.undo()
      detail(`after undo 3: ${quote(env.text.toString())} p1=${formatStatus(env.statusMap.get(p1.id))} p2=${formatStatus(env.statusMap.get(p2.id))}`)
      assertEqual(env.text.toString(), INITIAL_TEXT, 'Undo 3 should revert accepted proposal')
      assertStatus(env.statusMap, p1.id, undefined, 'Undo 3 should restore P1 to pending')
    }
  },
  {
    name: 'captureTimeout merging: Accept + immediate typing merges into one undo step',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      acceptProposal(env, proposal)
      env.doc.transact(() => {
        appendText(env.text, ' hello')
      }, ORIGIN_HUMAN)

      detail(`after actions: ${quote(env.text.toString())} undoStack=${env.undoManager.undoStack.length}`)
      assertEqual(env.undoManager.undoStack.length, 1, 'Expected accept + immediate typing to merge into one undo step')
    }
  },
  {
    name: 'stopCapturing prevents merging',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      acceptProposal(env, proposal)
      env.undoManager.stopCapturing()
      env.doc.transact(() => {
        appendText(env.text, ' hello')
      }, ORIGIN_HUMAN)

      detail(`after actions: ${quote(env.text.toString())} undoStack=${env.undoManager.undoStack.length}`)
      assertEqual(env.undoManager.undoStack.length, 2, 'Expected stopCapturing to force a second undo step')
    }
  },
  {
    name: 'ORIGIN_GC is NOT tracked',
    run: detail => {
      const env = setupDoc()
      const proposalId = 'p1'
      const before = env.undoManager.undoStack.length

      env.doc.transact(() => {
        env.statusMap.set(proposalId, 'stale')
      }, ORIGIN_GC)

      detail(`undoStack before=${before} after=${env.undoManager.undoStack.length} status=${formatStatus(env.statusMap.get(proposalId))}`)
      assertEqual(env.undoManager.undoStack.length, before, 'ORIGIN_GC should not grow the undo stack')
    }
  },
  {
    name: 'undoManager.clear() empties both stacks',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      acceptProposal(env, proposal)
      separateUndoStep(env.undoManager)
      rejectProposal(env, 'p2')
      env.undoManager.undo()

      detail(`before clear: undoStack=${env.undoManager.undoStack.length} redoStack=${env.undoManager.redoStack.length}`)
      assert(env.undoManager.undoStack.length > 0, 'Expected undo stack to have entries before clear')
      assert(env.undoManager.redoStack.length > 0, 'Expected redo stack to have entries before clear')

      env.undoManager.clear()
      detail(`after clear: undoStack=${env.undoManager.undoStack.length} redoStack=${env.undoManager.redoStack.length}`)
      assertEqual(env.undoManager.undoStack.length, 0, 'clear() should empty the undo stack')
      assertEqual(env.undoManager.redoStack.length, 0, 'clear() should empty the redo stack')
    }
  },
  {
    name: 'Y.Map set() is tracked by UndoManager',
    run: detail => {
      const env = setupDoc()
      const key = 'p1'

      env.doc.transact(() => {
        env.statusMap.set(key, 'accepted')
      }, ORIGIN_ACCEPT)

      detail(`after set: status=${formatStatus(env.statusMap.get(key))} undoStack=${env.undoManager.undoStack.length}`)
      assertEqual(env.undoManager.undoStack.length, 1, 'Map set should create an undo step')

      env.undoManager.undo()
      detail(`after undo: status=${formatStatus(env.statusMap.get(key))} undoStack=${env.undoManager.undoStack.length}`)
      assertStatus(env.statusMap, key, undefined, 'Undo should remove newly added key')
    }
  },
  {
    name: 'Y.Map: undo of set() when prior value existed',
    run: detail => {
      const env = setupDoc()
      const key = 'p1'

      env.statusMap.set(key, 'rejected')
      env.undoManager.clear()
      env.doc.transact(() => {
        env.statusMap.set(key, 'accepted')
      }, ORIGIN_ACCEPT)

      detail(`after overwrite: status=${formatStatus(env.statusMap.get(key))}`)
      env.undoManager.undo()
      detail(`after undo: status=${formatStatus(env.statusMap.get(key))}`)
      assertStatus(env.statusMap, key, 'rejected', 'Undo should restore the prior value instead of deleting the key')
    }
  },
  {
    name: 'Y.Map is included in encodeStateAsUpdate/applyUpdate',
    run: detail => {
      const docA = createDoc()
      const mapA = docA.getMap('_proposal_status')
      mapA.set('p1', 'accepted')

      const docB = createDoc()
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
      const mapB = docB.getMap('_proposal_status')

      detail(`docB status: ${formatStatus(mapB.get('p1'))}`)
      assertStatus(mapB, 'p1', 'accepted', 'Encoded state update should include Y.Map contents')
    }
  },
  {
    name: 'Clone captures Y.Map state',
    run: detail => {
      const env = setupDoc()
      env.statusMap.set('p1', 'accepted')

      const clone = cloneDoc(env.doc)
      const cloneStatus = clone.getMap('_proposal_status')

      detail(`clone status: ${formatStatus(cloneStatus.get('p1'))}`)
      assertStatus(cloneStatus, 'p1', 'accepted', 'Cloned document should preserve Y.Map entries')
    }
  },
  {
    name: 'Y.applyUpdate inside transact() inherits outer origin',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')
      const observedOrigins = []
      env.doc.on('afterTransaction', transaction => {
        observedOrigins.push(transaction.origin)
      })

      env.doc.transact(() => {
        Y.applyUpdate(env.doc, proposal.yjs_update)
        env.statusMap.set(proposal.id, 'accepted')
      }, ORIGIN_ACCEPT)

      detail(`observed origins: ${observedOrigins.map(origin => String(origin)).join(', ')}`)
      detail(`undoStack=${env.undoManager.undoStack.length}`)
      assertEqual(observedOrigins.length, 1, 'Expected one transaction when applyUpdate runs inside outer transact()')
      assertEqual(observedOrigins[0], ORIGIN_ACCEPT, 'Expected applyUpdate to inherit the outer transaction origin')
      assertEqual(env.undoManager.undoStack.length, 1, 'Expected one undo step for grouped accept transaction')
    }
  },
  {
    name: 'Same yjs_update applied twice is a no-op',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      Y.applyUpdate(env.doc, proposal.yjs_update)
      const afterFirstApply = env.text.toString()
      Y.applyUpdate(env.doc, proposal.yjs_update)
      const afterSecondApply = env.text.toString()

      detail(`after first apply: ${quote(afterFirstApply)}`)
      detail(`after second apply: ${quote(afterSecondApply)}`)
      assertEqual(afterFirstApply, 'The black cat sat on the mat.', 'First apply should update the text')
      assertEqual(afterSecondApply, afterFirstApply, 'Reapplying identical update bytes should be a no-op')
    }
  },
  {
    name: 'Two proposals editing same region: CRDT composition',
    run: detail => {
      const env = setupDoc()
      const p1 = createBlackProposal(env.doc, 'p1')
      const p2 = createBigProposal(env.doc, 'p2')
      const clone = cloneDoc(env.doc)
      const cloneText = clone.getText('content')

      Y.applyUpdate(clone, p1.yjs_update)
      Y.applyUpdate(clone, p2.yjs_update)
      const composed = cloneText.toString()

      detail(`composed text: ${quote(composed)}`)
      assert(/The (black big|big black) cat sat on the mat\./.test(composed), 'Expected both overlapping insertions to compose into the text')
    }
  },
  {
    name: 'Overlapping accept -> individual thread undo may conflict',
    run: detail => {
      const env = setupDoc()
      const p1 = createBlackProposal(env.doc, 'p1')
      const p2 = createBigProposal(env.doc, 'p2')

      env.doc.transact(() => {
        Y.applyUpdate(env.doc, p1.yjs_update)
        env.statusMap.set(p1.id, 'accepted')
        Y.applyUpdate(env.doc, p2.yjs_update)
        env.statusMap.set(p2.id, 'accepted')
      }, ORIGIN_ACCEPT)

      const current = env.text.toString()
      const soloSearch = p1.region_text_after
      const foundIndex = current.indexOf(soloSearch)

      detail(`after grouped accept: ${quote(current)}`)
      detail(`search for ${quote(soloSearch)} -> index=${foundIndex}`)
      assert(foundIndex === -1, 'Expected solo region_text_after search to fail after overlapping CRDT composition')
    }
  },
  {
    name: 'Projection pipeline Pass 1: combined diff canonical -> projection',
    run: detail => {
      const env = setupDoc()
      const p1 = createBlackProposal(env.doc, 'p1')
      const p2 = createRugProposal(env.doc, 'p2')
      const result = deriveProjectionPipeline(env, [p1, p2], 1)

      detail(`canonical: ${quote(result.canonicalText)}`)
      detail(`projected: ${quote(result.projectedText)}`)
      detail(`grouped hunks: ${result.hunks.length}`)
      assertEqual(result.projectedText, 'The black cat sat on the rug.', 'Projection should apply all pending proposal updates')
      assertEqual(result.hunks.length, 2, 'Non-overlapping proposals should stay as two grouped hunks')
    }
  },
  {
    name: 'Projection pipeline Pass 2 attribution: overlapping proposals map to one grouped hunk',
    run: detail => {
      const env = setupDoc()
      const p1 = createBlackProposal(env.doc, 'p1')
      const p2 = createBigProposal(env.doc, 'p2')
      const result = deriveProjectionPipeline(env, [p1, p2], 2)

      detail(`projected: ${quote(result.projectedText)}`)
      detail(`hunks: ${result.hunks.length}`)
      assertEqual(result.hunks.length, 1, 'Overlapping proposals should merge into one grouped hunk')
      const ids = result.hunks[0].proposals.map(p => p.id).sort().join(',')
      detail(`hunk proposal IDs: ${ids}`)
      assertEqual(ids, 'p1,p2', 'Grouped hunk should carry both proposal IDs')
      assertEqual(result.hunks[0].sequenceNumber, 2, 'Grouped hunk should carry derivation sequence number')
    }
  },
  {
    name: 'Grouping rule: single proposal touching multiple regions stays atomic',
    run: detail => {
      const env = setupDoc()
      const p1 = createDoubleEditProposal(env.doc, 'p1')
      const result = deriveProjectionPipeline(env, [p1], 3)

      detail(`projected: ${quote(result.projectedText)}`)
      detail(`hunks: ${result.hunks.length}`)
      assertEqual(result.hunks.length, 1, 'Two disjoint edits from one proposal should group into one hunk')
      assertEqual(result.hunks[0].proposals.length, 1, 'Grouped hunk should contain the single proposal')
      assertEqual(result.hunks[0].proposals[0].id, 'p1', 'Grouped hunk should reference proposal p1')
    }
  },
  {
    name: 'Stale pre-check marks stale and excludes proposal from projection',
    run: detail => {
      const env = setupDoc()
      const p1 = createBlackProposal(env.doc, 'p1')

      env.doc.transact(() => {
        insertBefore(env.text, 'cat', 'black ')
      }, ORIGIN_HUMAN)

      const result = deriveProjectionPipeline(env, [p1], 4)
      detail(`canonical after manual apply: ${quote(env.text.toString())}`)
      detail(`status p1: ${formatStatus(env.statusMap.get('p1'))}`)
      detail(`hunks: ${result.hunks.length}`)
      assertStatus(env.statusMap, 'p1', 'stale', 'Pre-check should mark proposal stale')
      assertEqual(result.hunks.length, 0, 'Stale proposals must not render as hunks')
      assertEqual(result.staleByPrecheck.length, 1, 'Pre-check stale set should include proposal')
    }
  },
  {
    name: 'Unstale: stale proposal returns to pending when pre-check no longer matches',
    run: detail => {
      const env = setupDoc()
      const p1 = createBlackProposal(env.doc, 'p1')

      env.doc.transact(() => {
        insertBefore(env.text, 'cat', 'black ')
      }, ORIGIN_HUMAN)
      deriveProjectionPipeline(env, [p1], 5)
      assertStatus(env.statusMap, 'p1', 'stale', 'Setup: proposal should be stale first')

      env.doc.transact(() => {
        replaceFirst(env.text, 'black cat', 'cat')
      }, ORIGIN_HUMAN)
      const result = deriveProjectionPipeline(env, [p1], 6)

      detail(`status p1 after rollback: ${formatStatus(env.statusMap.get('p1'))}`)
      detail(`hunks: ${result.hunks.length}`)
      assertStatus(env.statusMap, 'p1', undefined, 'Proposal should be unstaled back to pending (key removed)')
      assertEqual(result.hunks.length, 1, 'Unstaled proposal should render as a hunk again')
      assertEqual(result.unstaleIDs.length, 1, 'Unstale list should include proposal')
    }
  },
  {
    name: 'Empty attribution catch marks stale when solo diff is empty',
    run: detail => {
      const env = setupDoc()
      const p1 = createDeleteMatProposal(env.doc, 'p1')

      env.doc.transact(() => {
        replaceFirst(env.text, 'mat', '')
      }, ORIGIN_HUMAN)

      const result = deriveProjectionPipeline(env, [p1], 7)
      detail(`canonical: ${quote(env.text.toString())}`)
      detail(`status p1: ${formatStatus(env.statusMap.get('p1'))}`)
      detail(`staleByEmptyAttribution: ${result.staleByEmptyAttribution.join(',')}`)
      assertStatus(env.statusMap, 'p1', 'stale', 'Empty attribution should mark proposal stale')
      assertEqual(result.staleByEmptyAttribution.length, 1, 'Expected empty attribution stale list to include proposal')
    }
  },
  {
    name: 'Parity fixture generation includes base64 updates and projected output',
    run: detail => {
      const fixture = buildParityFixture()
      detail(`canonical: ${quote(fixture.canonical_text)}`)
      detail(`projected: ${quote(fixture.projected_text)}`)
      detail(`proposals: ${fixture.proposals.length}`)
      assertEqual(fixture.projected_text, 'The black cat sat on the rug.', 'Parity fixture projected text should match JS projection')
      assertEqual(fixture.proposals.length, 2, 'Parity fixture should include proposals')
      assert(fixture.proposals.every(p => p.yjs_update_base64.length > 0), 'Each fixture proposal should include encoded update bytes')
    }
  },
  {
    name: 'Redo after undo',
    run: detail => {
      const env = setupDoc()
      const proposal = createBlackProposal(env.doc, 'p1')

      acceptProposal(env, proposal)
      env.undoManager.undo()
      detail(`after undo: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)
      env.undoManager.redo()
      detail(`after redo: ${quote(env.text.toString())} status=${formatStatus(env.statusMap.get(proposal.id))}`)
      assertEqual(env.text.toString(), 'The black cat sat on the mat.', 'Redo should restore accepted text')
      assertStatus(env.statusMap, proposal.id, 'accepted', 'Redo should restore accepted status')
    }
  },
  {
    name: 'Origins are NOT carried in wire format',
    run: detail => {
      const docA = createDoc()
      const textA = docA.getText('content')
      const mapA = docA.getMap('_proposal_status')
      docA.transact(() => {
        textA.insert(0, 'The black cat sat on the mat.')
        mapA.set('p1', 'accepted')
      }, ORIGIN_ACCEPT)

      const docB = createDoc()
      const textB = docB.getText('content')
      const mapB = docB.getMap('_proposal_status')
      const undoManagerB = new Y.UndoManager([textB, mapB], {
        trackedOrigins: new Set(TRACKED_ORIGINS)
      })
      const observedOrigins = []
      docB.on('afterTransaction', transaction => {
        observedOrigins.push(transaction.origin)
      })

      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

      detail(`docB text: ${quote(textB.toString())} status=${formatStatus(mapB.get('p1'))}`)
      detail(`docB observed origins: ${observedOrigins.map(origin => String(origin)).join(', ')}`)
      detail(`docB undoStack=${undoManagerB.undoStack.length}`)
      assertEqual(textB.toString(), 'The black cat sat on the mat.', 'Wire update should apply document state on docB')
      assertStatus(mapB, 'p1', 'accepted', 'Wire update should apply map state on docB')
      assertEqual(observedOrigins.length, 1, 'Expected one remote transaction on docB')
      assert(observedOrigins[0] == null, 'Expected remote transaction origin to be null/undefined, not ORIGIN_ACCEPT')
      assertEqual(undoManagerB.undoStack.length, 0, 'UndoManager should not track remote update without a tracked origin')
    }
  }
]

let passed = 0
const failed = []

for (const [index, test] of tests.entries()) {
  const details = []
  const detail = line => {
    details.push(`  ${line}`)
  }

  console.log(`TEST ${index + 1}: ${test.name}`)
  try {
    test.run(detail)
    details.forEach(line => console.log(line))
    console.log('  PASS ✓')
    passed += 1
  } catch (error) {
    details.forEach(line => console.log(line))
    console.log(`  FAIL ✗ ${error instanceof Error ? error.message : String(error)}`)
    failed.push(index + 1)
  }
  console.log('')
}

console.log(`RESULTS: ${passed}/${tests.length} passed, ${failed.length} failed`)
console.log(`FAILED: ${failed.length > 0 ? failed.join(', ') : 'none'}`)

if (failed.length > 0) {
  process.exitCode = 1
}
