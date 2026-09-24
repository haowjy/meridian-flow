ALTER TABLE "threads" DROP COLUMN "spawn_result"; -- migration-lint: skip DROP_COLUMN (pre-release removal; report rows are the saved result authority and no runtime read path uses this column)
