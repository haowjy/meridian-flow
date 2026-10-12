SET LOCAL lock_timeout = '5s';
ALTER TABLE "context_availability_heads" ADD COLUMN "namespace_generation" bigint DEFAULT 0 NOT NULL;
