/** Prevent detached server work from crossing DB test-file boundaries in shared workers. */
import { afterAll } from "vitest";
import { drainDetachedWork } from "./drizzle-reset.js";

afterAll(() => drainDetachedWork("finish the DB test file"));
