import { expect, it, vi } from 'vitest';
import { TranslationBatcher } from '@/lib/translation-batcher';

it('503 rejects current and queued translations without pretending originals were translated', async () => {
  const fetcher = vi.fn(async () => Response.json({}, { status: 503 }));
  const cache = new Map<string, string>();
  const batcher = new TranslationBatcher(1, 1, cache, 3, 0, undefined, fetcher);
  const results = await Promise.allSettled([
    batcher.translate('one', 'one', 'fr'),
    batcher.translate('two', 'two', 'fr'),
    batcher.translate('three', 'three', 'de'),
  ]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
  expect(cache.size).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async () => Response.json({ translations: ['un'] }));
  await expect(batcher.translate('one', 'one', 'fr')).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const retry = new TranslationBatcher(1, 1, cache, 3, 0, undefined, fetcher);
  expect(await retry.translate('one', 'one', 'fr')).toBe('un');
});
