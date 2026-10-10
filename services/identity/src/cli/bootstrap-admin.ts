/**
 * Bootstrap an admin (there is no public admin registration):
 *
 *   npm run bootstrap-admin -w @thali/identity -- --email ops@thali.in --name "Ops" --role SUPER_ADMIN
 *   echo -n 'chosen-password' | npm run bootstrap-admin -w @thali/identity -- --email ... --name ... --role OPS --password-stdin
 *
 * Prints a one-time password (unless --password-stdin). Refuses if the email already exists.
 * `--role` may be repeated or comma-separated (SUPER_ADMIN | OPS | FINANCE | SUPPORT).
 * Env: MONGO_URI (required), IDENTITY_DB_NAME (default thali_identity).
 * The admin must enrol TOTP on first login (POST /auth/admin/mfa/setup → /mfa/enable).
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Connection } from 'mongoose';
import { AdminRole, DomainError, enumValues, type AdminRole as AdminRoleT } from '@thali/contracts';
import { connectMongo } from '@thali/service-kit';
import { initIdentityDb } from '../db.js';
import { bootstrapAdmin } from '../domain/admin-auth.js';

export interface CliIo {
  conn: Connection;
  write: (s: string) => void;
  writeErr?: (s: string) => void;
  readStdin?: () => Promise<string>;
}

const USAGE =
  'Usage: bootstrap-admin --email <email> --name <name> --role <SUPER_ADMIN|OPS|FINANCE|SUPPORT> [--role ...] [--password-stdin]\n';

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** Returns the process exit code. */
export async function runBootstrapAdmin(argv: string[], io: CliIo): Promise<number> {
  const err = io.writeErr ?? ((s: string) => process.stderr.write(s));
  let values: { email?: string; name?: string; role?: string[]; 'password-stdin'?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string', multiple: true },
        'password-stdin': { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const roles = (values.role ?? []).flatMap((r) => r.split(',')).map((r) => r.trim().toUpperCase()).filter(Boolean);
  const valid = enumValues(AdminRole) as string[];
  if (!values.email || !values.name || !roles.length || roles.some((r) => !valid.includes(r))) {
    err(USAGE);
    return 2;
  }

  let password: string | undefined;
  if (values['password-stdin']) {
    password = (await (io.readStdin ?? readAllStdin)()).replace(/\r?\n$/, '');
  }
  try {
    const result = await bootstrapAdmin(io.conn, {
      email: values.email,
      name: values.name,
      adminRoles: roles as AdminRoleT[],
      ...(password !== undefined ? { password } : {}),
    });
    io.write(`Created admin ${values.email.toLowerCase()} (${roles.join(', ')}) id=${result.userId}\n`);
    if (password === undefined) {
      io.write(`One-time password: ${result.password}\n`);
      io.write('Store it now — it will not be shown again. Enrol TOTP on first sign-in.\n');
    }
    return 0;
  } catch (e) {
    if (e instanceof DomainError) {
      err(`Refused: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    process.stderr.write('MONGO_URI is required\n');
    process.exit(2);
  }
  const conn = await connectMongo(uri, process.env.IDENTITY_DB_NAME ?? 'thali_identity');
  let code = 1;
  try {
    await initIdentityDb(conn);
    code = await runBootstrapAdmin(process.argv.slice(2), { conn, write: (s) => process.stdout.write(s) });
  } finally {
    await conn.close();
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`bootstrap-admin failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
