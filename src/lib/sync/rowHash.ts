/**
 * Columns added to a table after its rows were already hashed on devices (baselines in
 * localStorage). Their default value is left out of the hash, so an unchanged row hashes as an
 * older app version hashed it: the first boot after an update neither re-uploads every row nor
 * takes another device's newer row for an unsent edit here. Any other value is hashed as usual.
 * manual_mode: goals and projects, 1.6.0 (default false).
 */
const ADDED_COLUMN_DEFAULTS: ReadonlyArray<readonly [string, unknown]> = [['manual_mode', false]];

/** FNV-1a over the row JSON; toRow fixes the key order. No imports, so any sync module can use it. */
export function hashRow(row: Record<string, unknown>): string {
  let hashed = row;
  for (const [column, defaultValue] of ADDED_COLUMN_DEFAULTS) {
    if (column in hashed && hashed[column] === defaultValue) {
      const { [column]: _omitted, ...rest } = hashed;
      hashed = rest;
    }
  }
  return hashString(JSON.stringify(hashed));
}

/** FNV-1a (32-bit) over a string's UTF-16 code units, base 36: the hash hashRow gives its row JSON. */
export function hashString(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
