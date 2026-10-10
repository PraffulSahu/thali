/**
 * Express 5 route introspection for `GET /internal/routes`.
 *
 * Express 5's router (`router@2`) does not keep the mount path of `use()` layers, so this module
 * patches `Router.prototype.use` once (at import) to tag each new layer with the path it was
 * mounted at. Routes are then listed by walking `app.router.stack` recursively.
 */
import express from 'express';

const MOUNT = Symbol.for('thali.mountPath');

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  [MOUNT]?: string;
}
interface RouterLike {
  stack: Layer[];
  use: (...args: unknown[]) => unknown;
}

const proto = (express.Router as unknown as { prototype: RouterLike & { [MOUNT]?: boolean } }).prototype;
if (!proto[MOUNT]) {
  const originalUse = proto.use;
  proto.use = function patchedUse(this: RouterLike, ...args: unknown[]) {
    let first = args[0];
    while (Array.isArray(first) && first.length) first = first[0];
    const path = typeof first === 'function' ? '/' : String(args[0]);
    const before = this.stack.length;
    const out = originalUse.apply(this, args);
    for (let i = before; i < this.stack.length; i++) this.stack[i]![MOUNT] = path;
    return out;
  };
  proto[MOUNT] = true;
}

export interface RouteInfo {
  method: string;
  path: string;
}

function join(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

function walk(stack: Layer[], prefix: string, out: RouteInfo[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        for (const [m, on] of Object.entries(layer.route.methods)) {
          if (on) out.push({ method: m === '_all' ? 'ALL' : m.toUpperCase(), path: join(prefix, p) });
        }
      }
    } else if (layer.handle?.stack) {
      walk(layer.handle.stack, join(prefix, layer[MOUNT] ?? '/'), out);
    }
  }
}

/** Every route registered on the app (method upper-case, Express path syntax), sorted & de-duplicated. */
export function listRoutes(app: express.Express): RouteInfo[] {
  const out: RouteInfo[] = [];
  walk((app.router as unknown as RouterLike).stack, '', out);
  const seen = new Set<string>();
  return out
    .filter((r) => {
      const k = `${r.method} ${r.path}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
