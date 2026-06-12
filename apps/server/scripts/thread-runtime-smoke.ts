import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { EventType } from "@meridian/contracts/protocol";
import {
  createDb,
  eventJournal,
  projects,
  threads,
  turnBlocks,
  turns,
  works,
} from "@meridian/database";
import { eq, inArray } from "drizzle-orm";
import WebSocket from "ws";
import {
  createDrizzleEventJournalReader,
  createDrizzleEventJournalWriter,
  createThreadEventHub,
} from "../server/domains/threads/index.js";

try {
  loadEnvFile("../../.env");
} catch {}
try {
  loadEnvFile(".env");
} catch {}

const serverUrl = process.env.SMOKE_SERVER_URL;
const databaseUrl = process.env.DATABASE_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const email = process.env.TEST_USER_EMAIL ?? "test@meridian.dev";
const password = process.env.TEST_USER_PASSWORD ?? "meridian-dev";

if (!serverUrl) throw new Error("SMOKE_SERVER_URL is required");
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!supabaseUrl || !anonKey) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");

async function signIn(): Promise<{ token: string; userId: string }> {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { access_token: string; user: { id: string } };
  return { token: body.access_token, userId: body.user.id };
}

function wsUrlFor(url: string): string {
  const parsed = new URL("/api/threads/ws", url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
}

type SubscribedFrame = {
  type: "subscribed";
  catchup?: Array<{ seq: string; event: { type: string } }>;
};

function waitForSubscribed(ws: WebSocket): Promise<SubscribedFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for subscribed")), 10_000);
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string };
      if (frame.type === "subscribed") {
        clearTimeout(timeout);
        resolve(frame as SubscribedFrame);
      }
    });
  });
}

function waitForEventTypes(ws: WebSocket, expected: Set<string>): Promise<string[]> {
  const seen: string[] = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(`timed out waiting for ${[...expected].join(",")}; saw ${seen.join(",")}`),
        ),
      10_000,
    );
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as {
        type: string;
        event?: { type: string };
        catchup?: Array<{ event: { type: string } }>;
      };
      if (frame.type === "event" && frame.event) {
        seen.push(frame.event.type);
      }
      if (frame.type === "subscribed") {
        for (const entry of frame.catchup ?? []) seen.push(entry.event.type);
      }
      if ([...expected].every((type) => seen.includes(type))) {
        clearTimeout(timeout);
        resolve(seen);
      }
    });
  });
}

const { token, userId } = await signIn();
const db = createDb(databaseUrl);
const projectId = randomUUID();
const workId = randomUUID();
const threadId = randomUUID();
const beforeActivity = new Date(Date.now() - 60_000);

await db.insert(projects).values({
  id: projectId,
  userId,
  name: "Phase 3 smoke",
  slug: `phase-3-smoke-${projectId}`,
  lastActivityAt: beforeActivity,
});
await db
  .insert(works)
  .values({ id: workId, projectId, createdByUserId: userId, title: "Smoke work" });
await db.insert(threads).values({
  id: threadId,
  projectId,
  workId,
  createdByUserId: userId,
  title: "Smoke thread",
});

const ws = new WebSocket(wsUrlFor(serverUrl), {
  headers: { authorization: `Bearer ${token}` },
});
await waitForOpen(ws);

const eventsPromise = waitForEventTypes(
  ws,
  new Set([
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
  ]),
);
const subscribedPromise = waitForSubscribed(ws);
ws.send(JSON.stringify({ type: "subscribe", threadId, lastSeq: "0" }));
await subscribedPromise;

const response = await fetch(new URL(`/api/threads/${threadId}/messages`, serverUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ text: "hello phase three" }),
});
if (response.status !== 202)
  throw new Error(`POST failed: ${response.status} ${await response.text()}`);
const postBody = (await response.json()) as { userTurnId: string; assistantTurnId: string };
const seenEvents = await eventsPromise;
ws.close();

const catchupWs = new WebSocket(wsUrlFor(serverUrl), {
  headers: { authorization: `Bearer ${token}` },
});
await waitForOpen(catchupWs);
const catchupPromise = waitForSubscribed(catchupWs);
catchupWs.send(JSON.stringify({ type: "subscribe", threadId, lastSeq: "0" }));
const catchupFrame = await catchupPromise;
catchupWs.close();

const contentSeq = catchupFrame.catchup?.find(
  (entry) => entry.event.type === EventType.TEXT_MESSAGE_CONTENT,
)?.seq;
if (!contentSeq) throw new Error("catchup missing content seq");

const resumeWs = new WebSocket(wsUrlFor(serverUrl), {
  headers: { authorization: `Bearer ${token}` },
});
await waitForOpen(resumeWs);
const resumePromise = waitForSubscribed(resumeWs);
resumeWs.send(JSON.stringify({ type: "subscribe", threadId, lastSeq: contentSeq }));
const resumeFrame = await resumePromise;
resumeWs.close();

const coldReplayHub = createThreadEventHub({
  journalReader: createDrizzleEventJournalReader(db),
  journalWriter: createDrizzleEventJournalWriter(db),
});
const coldResumeEvents = await coldReplayHub.catchup(threadId, BigInt(contentSeq));

const [thread] = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
const createdTurns = await db.select().from(turns).where(eq(turns.threadId, threadId));
const createdBlocks = await db
  .select()
  .from(turnBlocks)
  .where(inArray(turnBlocks.turnId, [postBody.userTurnId, postBody.assistantTurnId]));
const journalRows = await db.select().from(eventJournal).where(eq(eventJournal.threadId, threadId));
const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);

if (!thread) throw new Error("thread missing after POST");
if (thread.activeLeafTurnId !== postBody.assistantTurnId)
  throw new Error("active leaf did not advance");
if (thread.turnCount !== 2) throw new Error(`turn_count=${thread.turnCount}, expected 2`);
if (createdTurns.length !== 2) throw new Error(`turn rows=${createdTurns.length}, expected 2`);
const userBlock = createdBlocks.find((block) => block.turnId === postBody.userTurnId);
const assistantBlock = createdBlocks.find((block) => block.turnId === postBody.assistantTurnId);
if (userBlock?.compact !== "hello phase three") throw new Error("user text block missing");
if (!assistantBlock?.modelText || assistantBlock.modelText.length === 0) {
  throw new Error("assistant final text block missing");
}
if (journalRows.length !== 4) throw new Error(`journal rows=${journalRows.length}, expected 4`);
if (!project || project.lastActivityAt <= beforeActivity)
  throw new Error("project activity did not advance");
const catchupEventTypes = (catchupFrame.catchup ?? []).map((entry) => entry.event.type);
for (const expected of [
  EventType.RUN_STARTED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.RUN_FINISHED,
]) {
  if (!catchupEventTypes.includes(expected)) throw new Error(`catchup missing ${expected}`);
}
const resumeEventTypes = (resumeFrame.catchup ?? []).map((entry) => entry.event.type);
for (const expected of [EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED]) {
  if (!resumeEventTypes.includes(expected)) throw new Error(`resume missing ${expected}`);
}
const coldResumeEventTypes = coldResumeEvents.map((entry) => entry.event.type);
for (const expected of [EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED]) {
  if (!coldResumeEventTypes.includes(expected)) {
    throw new Error(`cold replay resume missing ${expected}`);
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      serverUrl,
      threadId,
      userTurnId: postBody.userTurnId,
      assistantTurnId: postBody.assistantTurnId,
      turnCount: thread.turnCount,
      journalSeqs: journalRows
        .map((row) => row.seq.toString())
        .sort((a, b) => Number(a) - Number(b)),
      wsEventTypes: seenEvents,
      catchupEventTypes,
      resumeEventTypes,
      coldResumeEventTypes,
    },
    null,
    2,
  ),
);

await db.close();
