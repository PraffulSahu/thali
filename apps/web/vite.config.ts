import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * `@thali/contracts` declares no `sideEffects`, so Rollup keeps every top-level zod schema and the phone
 * metadata as soon as one symbol (e.g. `formatINR`) is imported from the root. Its modules are pure
 * definitions, so let the web build tree-shake them: unused schemas drop out and libphonenumber only ships
 * in the chunks that actually normalize phones.
 */
function contractsSideEffectFree(): Plugin {
  return {
    name: 'thali:contracts-side-effect-free',
    transform(code, id) {
      if (/[\\/]packages[\\/]contracts[\\/]src[\\/]/.test(id)) return { code, map: null, moduleSideEffects: false };
      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), contractsSideEffectFree()],
  resolve: {
    // Use workspace sources directly so packages need no prebuild (tsconfig `paths` mirrors this).
    alias: [
      { find: /^@thali\/contracts$/, replacement: src('../../packages/contracts/src/index.ts') },
      { find: /^@thali\/pricing$/, replacement: src('../../packages/pricing/src/index.ts') },
    ],
  },
  server: {
    port: 5173,
    // Gateway in dev. SSE (/api/v1/realtime/stream) streams through http-proxy unbuffered.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false, ws: false },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
