-- Preflight precedes any extension-dependent DDL; original float8 arrays are preserved.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION 'pgvector is unavailable. Install pgvector >= 0.8.0 for PostgreSQL 17 on the database host (self-hosted: pgvector/pgvector:0.8.1-pg17), then rerun migrations. Existing vector data is unchanged.';
  END IF;
END $$;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
DO $$ DECLARE v text; BEGIN
  SELECT extversion INTO v FROM pg_extension WHERE extname = 'vector';
  IF string_to_array(v, '.')::int[] < ARRAY[0,8,0] THEN
    RAISE EXCEPTION 'pgvector >= 0.8.0 is required for strict iterative scans. Install the newer extension files and run ALTER EXTENSION vector UPDATE before retrying.';
  END IF;
END $$;
