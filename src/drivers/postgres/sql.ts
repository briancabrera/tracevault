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

/**
 * Multi-row INSERT using one array parameter per column, so the statement
 * text stays constant regardless of batch size.
 */
export function buildInsertManySql(tableName: string): string {
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
    )
    SELECT * FROM unnest(
      $1::uuid[], $2::varchar[], $3::varchar[], $4::varchar[], $5::varchar[],
      $6::varchar[], $7::jsonb[], $8::jsonb[], $9::varchar[], $10::timestamptz[],
      $11::varchar[], $12::varchar[], $13::varchar[]
    )
  `;
}
