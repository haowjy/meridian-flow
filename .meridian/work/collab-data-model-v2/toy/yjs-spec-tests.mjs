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

const createProposal = (canonicalDoc, { id, edit, regionTextBefore, regionTextAfter }) => {
  const clone = cloneDoc(canonicalDoc)
  let capturedUpdate = null
  clone.on('update', update => {
    capturedUpdate = capturedUpdate === null ? update : Y.mergeUpdates([capturedUpdate, update])
  })
  edit(clone.getText('content'), clone.getMap('_proposal_status'), clone)
  if (capturedUpdate === null) {
    throw new Error(`Proposal ${id} did not emit a Yjs update`)
  }
  return {
    id,
    yjs_update: capturedUpdate,
    region_text_before: regionTextBefore,
    region_text_after: regionTextAfter
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
