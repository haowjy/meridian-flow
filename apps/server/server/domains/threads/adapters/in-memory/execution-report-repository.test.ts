/** Repository contract against the transaction-owned in-memory report adapter. */
import { executionReportContract } from "../../../../test-support/execution-report-contract.js";
import { executionScenario } from "../../../../test-support/execution-scenario.js";

executionReportContract(() => executionScenario());
