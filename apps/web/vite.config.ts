import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Use workspace sources directly in dev so packages need no prebuild.
    alias: [
      { find: /^@thali\/contracts$/, replacement: src('../../packages/contracts/src/index.ts') },
      { find: /^@thali\/pricing$/, replacement: src('../../packages/pricing/src/index.ts') },
    ],
  },
  server: { port: 5173 },
});
