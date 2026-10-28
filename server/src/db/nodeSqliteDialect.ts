import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { type SqliteDatabase, SqliteDialect, type SqliteStatement } from 'kysely';

/**
 * Kysely's SQLite dialect expects statements with a `reader` flag that take parameters as an
 * array; Node's built-in `node:sqlite` reports columns instead and takes spread parameters.
 */
class NodeSqliteDatabase implements SqliteDatabase {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  close(): void {
    this.#db.close();
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.#db.prepare(sql);
    // SQLite compiles only the first statement; refuse the rest rather than skip it silently.
    if (this.#holdsAnother(sql.slice(stmt.sourceSQL.length))) {
      throw new Error(`SQL must hold one statement at a time, but this holds more: ${sql}`);
    }
    const args = (params: ReadonlyArray<unknown>) => params as SQLInputValue[];
    return {
      reader: stmt.columns().length > 0,
      all: (params) => stmt.all(...args(params)),
      run: (params) => stmt.run(...args(params)),
      iterate: (params) => stmt.iterate(...args(params)),
    };
  }

  /** Whether text left after a statement holds another one, not just spaces, comments or `;`. */
  #holdsAnother(rest: string): boolean {
    if (rest.trim() === '') return false;
    try {
      this.#db.prepare(rest);
      return true;
    } catch (error) {
      // node:sqlite reports text with nothing to run as an invalid argument; anything else
      // (a syntax error, say) means there is more.
      return (error as NodeJS.ErrnoException).code !== 'ERR_INVALID_ARG_VALUE';
    }
  }
}

export function nodeSqliteDialect(db: DatabaseSync): SqliteDialect {
  return new SqliteDialect({ database: new NodeSqliteDatabase(db) });
}
