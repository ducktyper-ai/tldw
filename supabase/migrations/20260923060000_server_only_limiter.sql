-- Server-only admission persistence. Existing permissive policies are ORed together;
-- a later USING(false) policy did not revoke the original public access.
BEGIN;
DO $$
DECLARE policy_name text;
BEGIN
  FOR policy_name IN SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'rate_limits'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.rate_limits', policy_name);
  END LOOP;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'limiter_executor') THEN
    CREATE ROLE limiter_executor NOLOGIN NOINHERIT;
  END IF;
END $$;
REVOKE ALL ON public.rate_limits FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO limiter_executor;
GRANT SELECT, INSERT, DELETE ON public.rate_limits TO limiter_executor;
CREATE POLICY limiter_executor_access ON public.rate_limits
  FOR ALL TO limiter_executor USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.check_rate_limit_server(
  p_key text, p_identifier text, p_window_ms bigint, p_max_requests integer, p_consume boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  request_count bigint;
  oldest timestamptz;
  current_time_value timestamptz := clock_timestamp();
  window_start timestamptz;
  reset_time timestamptz;
  allowed boolean;
BEGIN
  IF p_window_ms <= 0 OR p_window_ms > 2592000000 OR p_max_requests < 0 OR length(p_key) > 2048
     OR length(p_identifier) > 256 OR p_key IS NULL OR p_identifier IS NULL
     OR p_window_ms IS NULL OR p_max_requests IS NULL OR p_consume IS NULL THEN
    RAISE EXCEPTION 'Invalid limiter parameters';
  END IF;
  -- Count and admission write are one transaction, serialized per key.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key, 0));
  window_start := current_time_value - p_window_ms * interval '1 millisecond';
  SELECT count(*), min(timestamp) INTO request_count, oldest
    FROM public.rate_limits WHERE key = p_key AND timestamp >= window_start;
  allowed := request_count < p_max_requests;
  reset_time := coalesce(oldest, current_time_value) + p_window_ms * interval '1 millisecond';
  IF allowed AND p_consume THEN
    -- Bounded retention beyond the maximum supported window (30 days).
    -- Never expire the separate one-time guest allowance records.
    DELETE FROM public.rate_limits WHERE id IN (
      SELECT id FROM public.rate_limits
      WHERE key LIKE 'ratelimit:%' AND timestamp < current_time_value - interval '31 days'
      ORDER BY timestamp LIMIT 100
    );
    INSERT INTO public.rate_limits(key, identifier, timestamp)
      VALUES (p_key, p_identifier, current_time_value);
    request_count := request_count + 1;
  END IF;
  RETURN jsonb_build_object('allowed', allowed,
    'remaining', greatest(0, p_max_requests - request_count), 'reset_at', reset_time,
    'retry_after', greatest(1, ceil(extract(epoch FROM reset_time - current_time_value))));
END $$;

CREATE OR REPLACE FUNCTION public.guest_usage_server(p_identifiers text[], p_record boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE identifier_value text;
BEGIN
  IF cardinality(p_identifiers) NOT BETWEEN 1 AND 2 OR p_identifiers IS NULL OR p_record IS NULL THEN
    RAISE EXCEPTION 'Invalid guest identifiers';
  END IF;
  FOR identifier_value IN SELECT unnest(p_identifiers) ORDER BY 1 LOOP
    IF identifier_value IS NULL OR length(identifier_value) NOT BETWEEN 1 AND 256 THEN
      RAISE EXCEPTION 'Invalid guest identifier';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('guest-analysis:' || identifier_value, 0));
  END LOOP;
  IF p_record THEN
    INSERT INTO public.rate_limits(key, identifier)
      SELECT 'guest-analysis', value FROM unnest(p_identifiers) AS value
      WHERE NOT EXISTS (SELECT FROM public.rate_limits WHERE key = 'guest-analysis' AND identifier = value);
  END IF;
  RETURN EXISTS (SELECT FROM public.rate_limits
    WHERE key = 'guest-analysis' AND identifier = ANY(p_identifiers));
END $$;

-- The definer has only SELECT/INSERT/DELETE on this table, not general service privileges.
-- PostgreSQL 17 gives a non-superuser role creator ADMIN, but not SET or
-- INHERIT. Temporarily allow transfer and subsequent owner-only ACL changes.
GRANT limiter_executor TO CURRENT_USER WITH SET TRUE, INHERIT TRUE;
GRANT CREATE ON SCHEMA public TO limiter_executor;
ALTER FUNCTION public.check_rate_limit_server(text, text, bigint, integer, boolean) OWNER TO limiter_executor;
ALTER FUNCTION public.guest_usage_server(text[], boolean) OWNER TO limiter_executor;
REVOKE CREATE ON SCHEMA public FROM limiter_executor;
REVOKE ALL ON FUNCTION public.check_rate_limit_server(text, text, bigint, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guest_usage_server(text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit_server(text, text, bigint, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.guest_usage_server(text[], boolean) TO service_role;
GRANT limiter_executor TO CURRENT_USER WITH SET FALSE, INHERIT FALSE;
-- Public callers must not erase admission history through the old definer function.
REVOKE ALL ON FUNCTION public.cleanup_old_rate_limits() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.cleanup_old_rate_limits()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM public.rate_limits WHERE id IN (
    SELECT id FROM public.rate_limits
    WHERE key LIKE 'ratelimit:%' AND timestamp < now() - interval '31 days'
    ORDER BY timestamp LIMIT 1000
  );
$$;
COMMIT;
