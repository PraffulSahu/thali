import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8080';

/**
 * The gateway/identity CSRF guard only accepts allow-listed Origins (CSRF_ALLOWED_ORIGINS: :5173 and :8080 by
 * default). A dev/preview server on any other port (5173 is taken by the compose `web` container while the stack
 * runs) would get 403 CSRF_CHECK_FAILED from `POST /auth/refresh`, so a full reload lost the session. A
 * same-origin request to this dev server (Origin == http://<Host>) is rewritten to the proxy target's origin;
 * any other Origin (a foreign site) is forwarded untouched and still refused.
 */
const sameOriginAsTarget: NonNullable<ProxyOptions['configure']> = (proxy) => {
  const targetOrigin = new URL(API_TARGET).origin;
  proxy.on('proxyReq', (proxyReq, incoming) => {
    const { origin, host } = incoming.headers;
    if (origin && host && origin === `http://${host}`) proxyReq.setHeader('origin', targetOrigin);
  });
};

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
      '/api': { target: API_TARGET, changeOrigin: false, ws: false, configure: sameOriginAsTarget },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false, configure: sameOriginAsTarget },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
