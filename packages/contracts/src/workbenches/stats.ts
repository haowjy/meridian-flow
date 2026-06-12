/**
 * Purpose: Defines workbench-level aggregate stats for the Home destination.
 * Why independent: Home stats are a JSON-natural projection over threads and works, not a persistence entity.
 */
export interface WorkbenchStatsResponse {
  running: number;
  waiting: number;
  idle: number;
  totalThreads: number;
  works: number;
}
