import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { dependencyUnavailable } from '@/lib/dependency-unavailable';

// No browser session is attached to this client. Only these restricted RPCs are used.
export async function limiterDecision(key: string, identifier: string, windowMs: number, maxRequests: number, consume: boolean) {
  try {
    const { data, error } = await createServiceRoleClient().rpc('check_rate_limit_server', {
      p_key: key, p_identifier: identifier, p_window_ms: windowMs,
      p_max_requests: maxRequests, p_consume: consume,
    });
    if (error) throw error;
    if (!data || typeof data.allowed !== 'boolean' || !Number.isInteger(data.remaining) || data.remaining < 0 ||
        !Number.isFinite(data.retry_after) || !Number.isFinite(Date.parse(data.reset_at))) {
      throw new Error('Invalid limiter response');
    }
    return { allowed: data.allowed as boolean, remaining: data.remaining as number,
      resetAt: new Date(data.reset_at), retryAfter: data.retry_after as number };
  } catch (error) {
    throw dependencyUnavailable('rate-limit', error);
  }
}

export async function guestUsage(identifiers: string[], record = false): Promise<boolean> {
  try {
    const { data, error } = await createServiceRoleClient().rpc('guest_usage_server', {
      p_identifiers: identifiers, p_record: record,
    });
    if (error) throw error;
    if (typeof data !== 'boolean') throw new Error('Invalid guest usage response');
    return data;
  } catch (error) {
    throw dependencyUnavailable('guest-usage', error);
  }
}
