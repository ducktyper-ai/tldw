"use client";

import { SERVICE_UNAVAILABLE_MESSAGE } from '@/lib/dependency-unavailable';

export function ServiceUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <section className="mx-auto max-w-2xl px-5 py-16 text-center" aria-labelledby="service-unavailable-title">
      <h1 id="service-unavailable-title" className="text-xl font-semibold text-slate-900">Service temporarily unavailable</h1>
      <p role="alert" className="mt-3 text-sm text-slate-600">{SERVICE_UNAVAILABLE_MESSAGE}</p>
      <button type="button" onClick={onRetry ?? (() => window.location.reload())}
        className="mt-5 rounded-full bg-slate-900 px-5 py-2 text-sm text-white focus-visible:outline-2 focus-visible:outline-offset-2">
        Try again
      </button>
    </section>
  );
}
