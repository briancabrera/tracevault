/**
 * Build the parameterized INSERT statement for a given table name.
 *
 * The table name is validated upstream (see `validateConfig`) so it is safe
 * to interpolate here — we never accept user-level table names at runtime.
 */
export function buildInsertSql(tableName: string): string {
  return `
    INSERT INTO "${tableName}" (
      id,
      event,
      actor_id,
      actor_type,
      target_id,
      target_type,
      data,
      meta,
      mode,
      occurred_at,
      correlation_id,
      request_id,
      environment
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13
    )
  `;
}
