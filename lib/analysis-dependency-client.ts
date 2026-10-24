import { SERVICE_UNAVAILABLE_MESSAGE } from '@/lib/dependency-unavailable';

// Cache/preflight failures must never be interpreted as permission to generate.
export async function fetchAnalysisDependency(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetch(input, init);
    if (!response.ok) throw new Error(SERVICE_UNAVAILABLE_MESSAGE);
    return response;
  } catch {
    throw new Error(SERVICE_UNAVAILABLE_MESSAGE);
  }
}
