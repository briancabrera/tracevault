import type { NormalizedQueryFilters } from "./validator.js";

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

const SELECT_COLUMNS =
  'id, event, actor_id, actor_type, target_id, target_type, ' +
  'data, meta, mode, occurred_at, created_at, ' +
  'correlation_id, request_id, environment';

/**
 * Build the SELECT … WHERE … ORDER BY … LIMIT … OFFSET … used by `findMany`.
 *
 * Every filter value is passed as a bound parameter; only `tableName` and
 * ordering are interpolated directly and both are pre-validated against a
 * strict identifier regex / enum elsewhere.
 */
export function buildFindManySql(
  tableName: string,
  filters: NormalizedQueryFilters,
): BuiltQuery {
  const { whereClause, params } = buildWhere(filters);
  const dir = filters.order === "asc" ? "ASC" : "DESC";
  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  params.push(filters.limit, filters.offset);

  const sql =
    `SELECT ${SELECT_COLUMNS} ` +
    `FROM "${tableName}" ` +
    `${whereClause} ` +
    `ORDER BY occurred_at ${dir}, id ${dir} ` +
    `LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  return { sql, params };
}

/**
 * Build the COUNT(*) query matching the same filter set as `findMany`.
 * Returned value should be parsed from text (bigint in Postgres).
 */
export function buildCountSql(
  tableName: string,
  filters: Omit<NormalizedQueryFilters, "limit" | "offset" | "order">,
): BuiltQuery {
  const { whereClause, params } = buildWhere(filters);
  const sql = `SELECT COUNT(*)::text AS c FROM "${tableName}" ${whereClause}`;
  return { sql, params };
}

/**
 * Build the SELECT by primary key used by `findById`.
 */
export function buildFindByIdSql(tableName: string, id: string): BuiltQuery {
  return {
    sql: `SELECT ${SELECT_COLUMNS} FROM "${tableName}" WHERE id = $1`,
    params: [id],
  };
}

function buildWhere(
  filters: Omit<NormalizedQueryFilters, "limit" | "offset" | "order"> & {
    limit?: number;
    offset?: number;
    order?: "asc" | "desc";
  },
): { whereClause: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];

  const push = (column: string, value: unknown): void => {
    params.push(value);
    conditions.push(`${column} = $${params.length}`);
  };

  if (filters.event !== null) push("event", filters.event);
  if (filters.actorId !== null) push("actor_id", filters.actorId);
  if (filters.actorType !== null) push("actor_type", filters.actorType);
  if (filters.targetId !== null) push("target_id", filters.targetId);
  if (filters.targetType !== null) push("target_type", filters.targetType);
  if (filters.correlationId !== null) push("correlation_id", filters.correlationId);
  if (filters.requestId !== null) push("request_id", filters.requestId);
  if (filters.environment !== null) push("environment", filters.environment);
  if (filters.mode !== null) push("mode", filters.mode);

  if (filters.from !== null) {
    params.push(filters.from);
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (filters.to !== null) {
    params.push(filters.to);
    conditions.push(`occurred_at <= $${params.length}`);
  }

  const whereClause =
    conditions.length === 0 ? "WHERE TRUE" : `WHERE ${conditions.join(" AND ")}`;
  return { whereClause, params };
}
