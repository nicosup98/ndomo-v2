/**
 * ndomo DB — FTS5 query escaping.
 *
 * FTS5 MATCH interprets special characters as syntax:
 *   " - ( ) : *
 * A raw user input like "auth-bug" causes FTS5 to parse "-bug" as a column
 * qualifier, throwing "SQLiteError: no such column: bug".
 *
 * The safe fix is to wrap the query in double quotes, making FTS5 treat the
 * entire string as a literal phrase. Internal double quotes are escaped by
 * doubling them ("").
 *
 * NOTE: Wrapped queries are phrase queries — FTS5 does NOT tokenize the
 * interior. This is correct for our use case (exact phrase with hyphens).
 * If boolean queries (AND/OR/NOT) are needed in the future, use selective
 * escaping instead of blanket wrapping.
 */
export function escapeFtsQuery(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}
