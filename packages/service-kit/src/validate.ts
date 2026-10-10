/**
 * Zod request validation (LLD 2.3). Parsed (coerced, stripped) values are put on `req.valid`;
 * Express 5's `req.query` is a getter, so never assign to it.
 *
 * @example
 *   const vCreate = validate({ body: CreateBody, params: z.object({ id: ObjectIdSchema }) });
 *   router.post('/:id', vCreate, async (req, res) => {
 *     const { body, params } = vCreate.get(req); // fully typed
 *   });
 */
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { DomainError } from '@thali/contracts';
import { zodIssues, type ValidationIssue } from './errors.js';

export interface ValidateSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
  headers?: z.ZodType;
}

type Out<S extends ValidateSchemas, K extends keyof ValidateSchemas> = S[K] extends z.ZodType
  ? z.output<S[K]>
  : undefined;

export interface Validated<S extends ValidateSchemas> {
  body: Out<S, 'body'>;
  query: Out<S, 'query'>;
  params: Out<S, 'params'>;
  headers: Out<S, 'headers'>;
}

export type Validator<S extends ValidateSchemas> = RequestHandler & {
  /** Typed view of `req.valid` for this validator's schemas. */
  get(req: Request): Validated<S>;
  /** The schemas (useful for OpenAPI registration). */
  schemas: S;
};

const PARTS = ['params', 'query', 'headers', 'body'] as const;

export function validate<S extends ValidateSchemas>(schemas: S): Validator<S> {
  const mw: RequestHandler = async (req, _res, next) => {
    const issues: ValidationIssue[] = [];
    const valid: Record<string, unknown> = { ...(req.valid ?? {}) };
    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = await schema.safeParseAsync(req[part] ?? (part === 'body' ? {} : undefined));
      if (result.success) valid[part] = result.data;
      else issues.push(...zodIssues(result.error, part));
    }
    if (issues.length) {
      throw new DomainError('VALIDATION_FAILED', 'Request validation failed', undefined, { issues });
    }
    req.valid = valid;
    next();
  };
  return Object.assign(mw, {
    get: (req: Request) => (req.valid ?? {}) as Validated<S>,
    schemas,
  });
}
