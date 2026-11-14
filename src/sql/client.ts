/**
 * The minimal SQL surface the SQL store and quota counter need. A `pg` `Pool`/`Client` already
 * has this shape; {@link sqliteClient} adapts Node's built-in `node:sqlite`.
 *
 * SQL in this package is written with `?` placeholders and converted to `$1, $2, …` for
 * PostgreSQL by {@link toDialect}. Values are always bound as parameters, never interpolated.
 *
 * @module
 */

/** Dialects the SQL store supports (MySQL is planned: FieldType columns already cover it). */
export type StoreDialect = 'postgres' | 'sqlite'

/** A value bound to a placeholder. */
export type SqlValue = string | number | null

/** Something that runs parameterised SQL. */
export interface SqlClient {
  query(
    sql: string,
    params: readonly SqlValue[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[]
    readonly rowCount?: number | null
  }>
}

/** Convert `?` placeholders to `$n` for PostgreSQL. The SQL must not contain literal `?`. */
export function toDialect(sql: string, dialect: StoreDialect): string {
  if (dialect !== 'postgres') return sql
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

/** The parts of `node:sqlite`'s `DatabaseSync` the adapter uses. */
export interface SqliteDatabaseLike {
  prepare(sql: string): {
    all(...params: SqlValue[]): unknown[]
    run(...params: SqlValue[]): { changes: number | bigint }
  }
}

/** Adapt a `node:sqlite` `DatabaseSync` (or a compatible API) to {@link SqlClient}. */
export function sqliteClient(db: SqliteDatabaseLike): SqlClient {
  return {
    async query(sql, params) {
      const statement = db.prepare(sql)
      if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
        const rows = statement.all(...params) as Record<string, unknown>[]
        return { rows, rowCount: rows.length }
      }
      const result = statement.run(...params)
      return { rows: [], rowCount: Number(result.changes) }
    },
  }
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

/** Quote a table name after validating it (no user input ever reaches this, but be strict). */
export function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) throw new RangeError(`invalid SQL identifier "${name}"`)
  return `"${name}"`
}
