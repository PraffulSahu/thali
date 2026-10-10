import type { Connection, Model, Schema } from 'mongoose';

/** Register (once per connection) and return a model. */
export function defineModel<T>(conn: Connection, name: string, schema: Schema<T>): Model<T> {
  return (conn.models[name] as Model<T> | undefined) ?? conn.model<T>(name, schema);
}
