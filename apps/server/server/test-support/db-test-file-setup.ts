import { afterAll, afterEach } from "vitest";
import { drainDetachedWork } from "./drizzle-reset.js";

afterEach(() => drainDetachedWork("finish the DB test case"));
afterAll(() => drainDetachedWork("finish the DB test file"));
