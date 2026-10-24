export const DEPENDENCY_UNAVAILABLE = 'DEPENDENCY_UNAVAILABLE';
export const SERVICE_UNAVAILABLE_MESSAGE = 'Analysis is temporarily unavailable. Please try again later.';

export class DependencyUnavailableError extends Error {
  readonly code = DEPENDENCY_UNAVAILABLE;
  constructor(readonly dependency: string) {
    super(SERVICE_UNAVAILABLE_MESSAGE);
    this.name = 'DependencyUnavailableError';
  }
}

// Only log a bounded dependency label and machine code, never provider messages/bodies.
export function dependencyUnavailable(dependency: string, cause?: unknown): DependencyUnavailableError {
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  console.error('[dependency-unavailable]', {
    dependency,
    code: typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN',
  });
  return new DependencyUnavailableError(dependency);
}

export function unavailableResponse() {
  return Response.json({
    error: SERVICE_UNAVAILABLE_MESSAGE,
    code: DEPENDENCY_UNAVAILABLE,
    retryable: true,
  }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
