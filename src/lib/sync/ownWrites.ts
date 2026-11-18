/**
 * This device's own writes, by the updated_at the server stored for them (column tables, see
 * SyncedCollection.dropsOwnStaleEchoes).
 *
 * A live row event older than the server's stored copy of this device's last write of that row is a
 * late echo of an earlier write (save A, save B, then A's echo arrives): the table's keep-newer
 * trigger never lets a row's updated_at go down, so the server already holds the newer row. The
 * realtime handler drops such an event instead of letting it undo the newer copy for a moment (or for
 * good, when another edit is built on it inside that moment). The server's own stored time is used,
 * not the device's stamp, so a device clock that runs ahead changes nothing.
 *
 * In memory, for one account at a time, and bounded: echoes come within seconds, so only the latest
 * writes matter. Other tabs do not see these records (they heal with the next echo or pull, as before).
 */

/** Rows remembered at most; the oldest record is forgotten first. */
export const MAX_OWN_WRITES = 500;

let owner: string | null = null;
const stored = new Map<string, number>();

const rowKey = (table: string, id: string) => `${table}:${id}`;

/**
 * Postgres timestamptz text (PostgREST or Realtime form) as microseconds since the epoch, so two
 * writes inside one millisecond still compare. NaN when it cannot be read.
 */
export function timestampMicros(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const match = /\.(\d+)/.exec(value);
  const ms = Date.parse(match ? value.replace(match[0], '') : value);
  if (!Number.isFinite(ms)) return NaN;
  const fraction = match ? Number(match[1].slice(0, 6).padEnd(6, '0')) : 0;
  return ms * 1000 + fraction;
}

/** Another account (or none) since the last record: forget everything. */
function ownedBy(userId: string): void {
  if (owner === userId) return;
  owner = userId;
  stored.clear();
}

/** Records the rows the server stored for this device's upsert ({ id, updated_at } each). */
export function noteOwnWrites(userId: string, table: string, rows: unknown): void {
  if (!Array.isArray(rows)) return;
  ownedBy(userId);
  for (const row of rows) {
    const { id, updated_at } = (row || {}) as { id?: unknown; updated_at?: unknown };
    const at = timestampMicros(updated_at);
    if (id == null || !Number.isFinite(at)) continue;
    const key = rowKey(table, String(id));
    const before = stored.get(key);
    stored.delete(key);
    stored.set(key, before !== undefined && before > at ? before : at);
  }
  while (stored.size > MAX_OWN_WRITES) stored.delete(stored.keys().next().value as string);
}

/**
 * A live event (not a delete) older than the server's stored copy of this device's last write of the
 * row: a late echo of an earlier write. A delete is never stale (deleted rows are frozen).
 */
export function isStaleOwnEcho(userId: string, table: string, row: Record<string, unknown>): boolean {
  if (owner !== userId || row.deleted_at || row.id == null) return false;
  const mine = stored.get(rowKey(table, String(row.id)));
  const at = timestampMicros(row.updated_at);
  return mine !== undefined && Number.isFinite(at) && at < mine;
}

/** Sign-out or account switch: forget every record. */
export function clearOwnWrites(): void {
  owner = null;
  stored.clear();
}

/** Records held now (tests). */
export const ownWriteCount = (): number => stored.size;
