/** Shared helpers for the root scripts (seed, seed-images, seed-verify). */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Minimal .env reader (KEY=VALUE, optional quotes, `#` comments). Missing file → {}. */
export function readDotEnv(file: string = resolve(ROOT, '.env')): Record<string, string> {
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    env[m[1]!] = v;
  }
  return env;
}

/** `.env` merged under the process environment (process wins). */
export function mergedEnv(): Record<string, string | undefined> {
  return { ...readDotEnv(), ...process.env };
}

/** Demo data (photos, documents) may only be written to a demo stack. */
export function assertDemoMode(env: Record<string, string | undefined> = mergedEnv(), what = 'seed'): void {
  if (env.APP_MODE !== 'demo') throw new Error(`Refusing to ${what}: APP_MODE=${env.APP_MODE ?? '(unset)'} (demo data is only allowed with APP_MODE=demo)`);
}
