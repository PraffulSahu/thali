import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOpenApi, toOpenApiPath } from '@thali/service-kit';

describe('createOpenApi', () => {
  it('converts express params to OpenAPI templates', () => {
    expect(toOpenApiPath('/api/v1/orders/:id/items/:itemId')).toBe('/api/v1/orders/{id}/items/{itemId}');
    expect(toOpenApiPath('/health/live')).toBe('/health/live');
  });

  it('registers routes with security and standard error responses', () => {
    const api = createOpenApi('orders');
    const Order = z.object({ id: z.string() });
    api.route({
      method: 'get',
      path: '/api/v1/orders/:id',
      summary: 'Get order',
      security: 'bearer',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Order', content: { 'application/json': { schema: Order } } } },
      errors: ['NOT_FOUND', 'ORDER_INVALID_TRANSITION'],
    });
    api.route({
      method: 'post',
      path: '/internal/quote',
      security: 'internal',
      request: { body: { content: { 'application/json': { schema: Order } } } },
      responses: { 200: { description: 'Quote' } },
      rateLimited: true,
    });
    api.route({
      method: 'get',
      path: '/api/v1/cuisines',
      responses: { 200: { description: 'List' } },
    });

    const doc = api.document();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Thali orders API');
    expect(doc.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      serviceToken: { type: 'http', scheme: 'bearer' },
    });
    expect(doc.components?.schemas?.ErrorEnvelope).toBeDefined();

    const get = doc.paths!['/api/v1/orders/{id}']!.get!;
    expect(get.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(get.responses!)).toEqual(expect.arrayContaining(['200', '400', '401', '403', '404', '409', '500']));
    expect(JSON.stringify(get.responses!['409'])).toMatch(/ORDER_INVALID_TRANSITION/);
    expect(JSON.stringify(get.responses!['404'])).toMatch(/#\/components\/schemas\/ErrorEnvelope/);

    const post = doc.paths!['/internal/quote']!.post!;
    expect(post.security).toEqual([{ serviceToken: [] }]);
    expect(Object.keys(post.responses!)).toEqual(expect.arrayContaining(['400', '401', '403', '429', '500']));

    const pub = doc.paths!['/api/v1/cuisines']!.get!;
    expect(pub.security).toEqual([]);
    expect(Object.keys(pub.responses!)).toEqual(['200', '500']);

    // kit routes are always documented
    expect(Object.keys(doc.paths!)).toEqual(
      expect.arrayContaining(['/health/live', '/health/ready', '/openapi.json', '/internal/routes']),
    );
  });
});
