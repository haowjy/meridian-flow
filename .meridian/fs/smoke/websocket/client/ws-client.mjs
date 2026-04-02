#!/usr/bin/env node
/**
 * Toy WebSocket client for edge case smoke testing.
 *
 * Usage:
 *   node ws-client.mjs <url> [flags]
 *
 * Examples:
 *   node ws-client.mjs ws://localhost:8080/ws/projects/$PID/threads --token $TOKEN
 *   node ws-client.mjs ws://localhost:8080/ws/projects/$PID/threads --token $TOKEN --subscribe turn:$TURN_ID
 *   node ws-client.mjs ws://localhost:8080/ws/projects/$PID/docs --token $TOKEN --subscribe document:$DOC_ID --binary
 *   node ws-client.mjs ws://localhost:8080/ws/projects/$PID/threads --token $TOKEN --flood 50
 *   node ws-client.mjs ws://localhost:8080/ws/projects/$PID/threads --token $TOKEN --no-pong
 *   node ws-client.mjs ws://localhost:8080/ws/projects/$PID/threads --token $TOKEN --freeze-after 5
 *   node ws-client.mjs ws://localhost:8080/ws/projects/$PID/threads --token $TOKEN --subscribe turn:$TURN_ID --interject "focus on chapter 3"
 */

import WebSocket from 'ws'

// Parse args
const args = process.argv.slice(2)
const url = args.find(a => a.startsWith('ws://') || a.startsWith('wss://'))
if (!url) { console.error('Usage: ws-client.mjs <ws://url> [flags]'); process.exit(1) }

const flag = (name) => args.includes(`--${name}`)
const flagVal = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null }

const token = flagVal('token')
const subscribe = flagVal('subscribe')     // "turn:uuid" or "document:uuid"
const lastSeq = Number(flagVal('last-seq')) || 0
const epoch = flagVal('epoch') || ''
const floodCount = Number(flagVal('flood')) || 0
const noPong = flag('no-pong')
const freezeAfter = Number(flagVal('freeze-after')) || 0
const badAuth = flag('bad-auth')
const binary = flag('binary')
const interjectText = flagVal('interject')
const verbose = flag('v')

// State
let subId = null
let eventCount = 0
let frozen = false
let lastReceivedSeq = 0
let lastReceivedEpoch = ''

const ws = new WebSocket(url)

function send(obj) {
  ws.send(JSON.stringify(obj))
}

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args)
}

ws.on('open', () => {
  log('connected to', url)

  // Auth
  const authToken = badAuth ? 'invalid-token-for-testing' : token
  if (authToken) {
    send({ kind: 'control', op: 'auth', payload: { token: authToken } })
    log('-> auth')
  }
})

ws.on('message', (data, isBinary) => {
  if (frozen) return

  // Binary frame (Yjs)
  if (isBinary) {
    const buf = Buffer.from(data)
    const nullIdx = buf.indexOf(0x00)
    if (nullIdx >= 0) {
      const frameSubId = buf.slice(0, nullIdx).toString()
      const payload = buf.slice(nullIdx + 1)
      log(`<- [binary] subId=${frameSubId} len=${payload.length} prefix=0x${payload[0]?.toString(16).padStart(2, '0')}`)
    } else {
      log(`<- [binary] raw len=${buf.length}`)
    }
    eventCount++
    checkFreeze()
    return
  }

  // Text frame (JSON)
  let env
  try {
    env = JSON.parse(data.toString())
  } catch {
    log('<- [raw]', data.toString().slice(0, 200))
    return
  }

  const { kind, op } = env

  // Ping/pong
  if (kind === 'control' && op === 'ping') {
    if (noPong) {
      log('<- ping (NOT responding — heartbeat timeout test)')
    } else {
      send({ kind: 'control', op: 'pong' })
      if (verbose) log('<- ping -> pong')
    }
    return
  }

  // Connected — now subscribe if requested
  if (kind === 'control' && op === 'connected') {
    log(`<- connected (id=${env.payload?.connectionId})`)
    doSubscribe()
    doFlood()
    return
  }

  // Subscribed
  if (kind === 'control' && op === 'subscribed') {
    lastReceivedEpoch = env.epoch || ''
    log(`<- subscribed subId=${env.subId} epoch=${env.epoch} headSeq=${env.payload?.headSeq} recovered=${env.payload?.recovered}`)
    doInterject()
    return
  }

  // Stream events
  if (kind === 'stream' && op === 'event') {
    lastReceivedSeq = env.seq
    lastReceivedEpoch = env.epoch || lastReceivedEpoch
    const payloadStr = JSON.stringify(env.payload)
    log(`<- event seq=${env.seq} ${payloadStr.slice(0, 80)}${payloadStr.length > 80 ? '...' : ''}`)
    eventCount++
    checkFreeze()
    return
  }

  // Ended
  if (kind === 'stream' && op === 'ended') {
    log(`<- ENDED reason=${env.payload?.reason} finalSeq=${env.payload?.finalSeq} newTurn=${env.payload?.newAssistantTurnId || 'n/a'}`)
    if (env.payload?.reason === 'stream_switch' && env.payload?.newAssistantTurnId) {
      log(`   -> would auto-subscribe to ${env.payload.newAssistantTurnId}`)
    }
    return
  }

  // Gap
  if (kind === 'stream' && op === 'gap') {
    log(`<- GAP fromSeq=${env.payload?.fromSeq} toSeq=${env.payload?.toSeq} cause=${env.payload?.cause}`)
    return
  }

  // Error
  if (kind === 'error') {
    log(`<- ERROR code=${env.payload?.code} msg=${env.payload?.message}`)
    return
  }

  // Interjection result
  if (kind === 'control' && op === 'interjection_result') {
    log(`<- interjection_result mode=${env.payload?.mode} target=${env.payload?.newAssistantTurnId || env.resource?.id}`)
    return
  }

  // Catch-all
  log(`<- ${kind}:${op} subId=${env.subId || ''} ${JSON.stringify(env.payload || {}).slice(0, 100)}`)
})

ws.on('close', (code, reason) => {
  log(`connection closed: ${code} ${reason}`)
  printReconnectHint()
  process.exit(0)
})

ws.on('error', (err) => {
  log('error:', err.message)
})

// Ctrl+C
process.on('SIGINT', () => {
  log('closing...')
  printReconnectHint()
  ws.close()
  process.exit(0)
})

function doSubscribe() {
  if (!subscribe) return
  const [type, id] = subscribe.split(':')
  subId = `smoke-${Date.now()}`
  const msg = {
    kind: 'control',
    op: 'subscribe',
    resource: { type, id },
    subId,
  }
  if (lastSeq || epoch) {
    msg.payload = { lastSeq, epoch }
  }
  send(msg)
  log(`-> subscribe ${subscribe} (subId=${subId})`)
}

function doFlood() {
  if (!floodCount) return
  log(`-> flooding ${floodCount} messages`)
  for (let i = 0; i < floodCount; i++) {
    send({ kind: 'control', op: `flood-${i}` })
  }
  log('-> flood sent')
}

function doInterject() {
  if (!interjectText || !subscribe) return
  const [type, id] = subscribe.split(':')
  send({
    kind: 'stream',
    op: 'message',
    resource: { type, id },
    payload: { action: 'interjection', text: interjectText, mode: 'append' },
  })
  log(`-> interjection: "${interjectText}"`)
}

function checkFreeze() {
  if (freezeAfter > 0 && eventCount >= freezeAfter) {
    frozen = true
    log(`!! frozen after ${eventCount} events (backpressure test) — not reading anymore`)
    log('   server should gap+terminate this subscription after queue fills')
  }
}

function printReconnectHint() {
  if (lastReceivedSeq > 0 && lastReceivedEpoch) {
    log(`\nReconnect hint: --last-seq ${lastReceivedSeq} --epoch ${lastReceivedEpoch}`)
  }
}
