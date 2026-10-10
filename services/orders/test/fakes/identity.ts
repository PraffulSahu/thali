/** In-memory IdentityClient fake (binding `GET /internal/users/:id` shape). */
import type { IdentityClient, InternalUser } from '../../src/clients/identity.js';

export class FakeIdentity implements IdentityClient {
  users = new Map<string, InternalUser>();
  down = false;

  addUser(id: string, over: Partial<InternalUser> = {}): InternalUser {
    const u: InternalUser = {
      id,
      phone: '+919876543210',
      email: null,
      name: 'Asha Rao',
      roles: ['CONSUMER'],
      status: 'ACTIVE',
      notificationPrefs: { orderSms: true, orderEmail: true, marketingSms: false, marketingEmail: false },
      ...over,
    };
    this.users.set(id, u);
    return u;
  }

  async getUser(id: string): Promise<InternalUser | null> {
    if (this.down) throw new Error('identity down');
    return this.users.get(id) ?? null;
  }
}
