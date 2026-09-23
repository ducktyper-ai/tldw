import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: {
    '@': fileURLToPath(new URL('.', import.meta.url)),
    'server-only': fileURLToPath(new URL('./tests/server-only.ts', import.meta.url)),
  } },
  esbuild: { jsx: 'automatic' },
  test: { include: ['tests/**/*.test.{ts,tsx}'], restoreMocks: true },
});
