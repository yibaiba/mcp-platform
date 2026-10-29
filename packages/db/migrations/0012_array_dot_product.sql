-- Unit-normalized float8 arrays preserve model dimensions and double precision.
-- Keep the scalar calculation parallel-safe so PostgreSQL can divide a large scope scan.
CREATE FUNCTION platform_vector_dot(a double precision[], b double precision[])
RETURNS double precision LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE COST 1000 AS $$
  SELECT greatest(-1::float8, least(1::float8, sum(v * b[i])))
  FROM unnest(a) WITH ORDINALITY AS values(v, i)
$$;
--> statement-breakpoint
ALTER TABLE tool_vectors SET (parallel_workers = 3);
