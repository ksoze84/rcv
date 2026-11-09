import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environmentMatchGlobs: [
      ['web/**', 'jsdom'],
      ['server/**', 'node'],
      ['shared/**', 'node'],
    ],
    setupFiles: ['./web/src/setupTests.ts'],
    include: ['**/*.test.{ts,tsx}'],
  },
});
