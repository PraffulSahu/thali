// Thali full-stack Mongo bootstrap (run by the `mongo-init` one-shot job in docker-compose.yml):
//   mongosh --host mongo:27017 -u root -p ... --authenticationDatabase admin --file init-replica.js
//
// 1. Initiates replica set rs0 (single member, host MONGO_RS_HOST) if it is not initiated yet.
// 2. Waits until this member is PRIMARY.
// 3. Creates (or updates password/roles of) one user per service in the admin database with readWrite
//    on that service's own database only: thali_<service>. Passwords come from MONGO_<SERVICE>_PASSWORD.
// Idempotent: safe to run on every `docker compose up`.

const RS_NAME = 'rs0';
const RS_HOST = process.env.MONGO_RS_HOST || 'mongo:27017';
const SERVICES = ['identity', 'marketplace', 'orders', 'payments', 'delivery', 'notifications'];

function isInitiated() {
  try {
    return rs.status().ok === 1;
  } catch (e) {
    if (e.codeName === 'NotYetInitialized' || /no replset config/i.test(String(e.message))) return false;
    throw e;
  }
}

if (!isInitiated()) {
  const res = rs.initiate({ _id: RS_NAME, members: [{ _id: 0, host: RS_HOST }] });
  print(`init-replica: rs.initiate -> ${JSON.stringify(res)}`);
} else {
  print('init-replica: replica set already initiated');
}

let primary = false;
for (let i = 0; i < 60 && !primary; i++) {
  primary = db.hello().isWritablePrimary === true;
  if (!primary) sleep(1000);
}
if (!primary) throw new Error('init-replica: member did not become PRIMARY within 60 s');
print('init-replica: PRIMARY ready');

const admin = db.getSiblingDB('admin');
for (const svc of SERVICES) {
  const user = `thali_${svc}`;
  const pwd = process.env[`MONGO_${svc.toUpperCase()}_PASSWORD`];
  if (!pwd) throw new Error(`init-replica: MONGO_${svc.toUpperCase()}_PASSWORD is not set`);
  const roles = [{ role: 'readWrite', db: `thali_${svc}` }];
  if (admin.getUser(user)) {
    admin.updateUser(user, { pwd, roles });
    print(`init-replica: updated user ${user} (readWrite on thali_${svc})`);
  } else {
    admin.createUser({ user, pwd, roles });
    print(`init-replica: created user ${user} (readWrite on thali_${svc})`);
  }
}
print('init-replica: done');
