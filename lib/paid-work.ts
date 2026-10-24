import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { getGuestAccessState } from '@/lib/guest-usage';
import { getUsageStats } from '@/lib/subscription-manager';
import { DependencyUnavailableError, dependencyUnavailable } from '@/lib/dependency-unavailable';

// Dependency readiness, not a new customer-credit policy. Endpoint-specific limits still apply.
export async function assertPaidDependencies(): Promise<void> {
  try {
    const client = await createClient();
    const { error: cacheError } = await client.from('video_analyses').select('id').limit(1);
    if (cacheError) throw dependencyUnavailable('video-cache', cacheError);
    const { data: { user }, error } = await client.auth.getUser();
    if (error && error.name !== 'AuthSessionMissingError') throw dependencyUnavailable('auth', error);
    if (user) {
      if (!await getUsageStats(user.id, { client })) throw dependencyUnavailable('spending-eligibility');
    } else {
      await getGuestAccessState();
    }
  } catch (error) {
    if (error instanceof DependencyUnavailableError) throw error;
    throw dependencyUnavailable('paid-preflight', error);
  }
}
