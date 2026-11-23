/**
 * Per-tab row versions for relational sync (see tabSyncedHashes), and the one writer of the device
 * cache they are stored with. No imports from the rest of the sync code (rowHash has none), so the
 * device-cache writers (store, supabase.ts) can use it without an import cycle.
 */
import type { AppState } from '@/types';
import { hashString } from './rowHash';

/** collection key -> item id -> row hash ('' = deleted), the same shape as the outbox baseline. */
export type Baseline = Record<string, Record<string, string>>;

/** The account's device cache (the state a cold boot starts from). */
const userCacheKey = (userId: string) => `ascend_user_cache_${userId}`;
/**
 * The row versions the cached state was built on. Format v2: `{"v":2,"cache":<fingerprint>,"hashes":
 * Baseline}`, where `cache` is the fingerprint of the exact cache string they were written with.
 * Older app versions stored the Baseline alone (legacy, see readVersions).
 */
const tabSyncedKey = (userId: string) => `ascend_sync_tab_synced_${userId}`;
/** Left by older app versions (which tab wrote the versions); no longer written, removed on clear. */
const legacyWriterKey = (userId: string) => `ascend_sync_tab_synced_writer_${userId}`;

/** Length + FNV-1a of the cache string: equal for the same string, so a record names its cache. */
export function cacheFingerprint(cacheJson: string): string {
  return `${cacheJson.length.toString(36)}.${hashString(cacheJson)}`;
}

function versionsRecord(fingerprint: string, hashes: Baseline): string {
  return `{"v":2,"cache":${JSON.stringify(fingerprint)},"hashes":${JSON.stringify(hashes)}}`;
}

/**
 * The versions a stored record gives for this cache string, or null (none, unreadable, or written
 * with another cache string). A legacy record (a plain Baseline from before v2) names no cache and
 * is taken as before: the app behaves as it did until this device's first v2 write replaces it.
 */
function readVersions(recordRaw: string | null, cacheRaw: string | null): Baseline | null {
  if (!recordRaw) return null;
  try {
    const parsed = JSON.parse(recordRaw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as { v?: unknown; cache?: unknown; hashes?: unknown };
    if (!('v' in record)) return parsed as Baseline;
    if (record.v !== 2 || typeof record.cache !== 'string') return null;
    if (!record.hashes || typeof record.hashes !== 'object' || Array.isArray(record.hashes)) return null;
    if (cacheRaw === null || cacheFingerprint(cacheRaw) !== record.cache) return null;
    return record.hashes as Baseline;
  } catch {
    return null;
  }
}

function getItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readStored(userId: string): Baseline | null {
  // Versions first, then the cache: a cache written in between gives a mismatch (the fallback),
  // never another cache generation's versions accepted.
  const recordRaw = getItem(tabSyncedKey(userId));
  return readVersions(recordRaw, getItem(userCacheKey(userId)));
}

/**
 * This tab's version of each row: collection key -> item id -> the row hash this tab's state last
 * held in step with the baseline (DELETED: this tab knows the row is deleted). The baseline and the
 * pull cursor are shared by every tab of the browser, but each tab's state is its own, so another
 * tab's pull can move the baseline past a copy this tab still shows. A copy still equal to this
 * tab's version is then an old copy, not an edit: it is never uploaded, and the server row replaces
 * it. Kept in memory (each tab has its own) and written next to the device cache, so a cold boot
 * from that cache starts from the versions the cached state was built on.
 */
let tabSynced: { userId: string; hashes: Baseline } | null = null;

/** The fingerprint of the cache string this tab last wrote (writeDeviceCache). */
let lastWrittenCache: { userId: string; fingerprint: string } | null = null;

export function tabSyncedHashes(userId: string): Baseline {
  if (tabSynced?.userId !== userId) tabSynced = { userId, hashes: readStored(userId) || {} };
  return tabSynced.hashes;
}

export function setTabSyncedHashes(userId: string, hashes: Baseline): void {
  tabSynced = { userId, hashes };
}

/**
 * The device cache and the versions stored with it, from one read of each key. `versions` is null
 * when none are stored or they were written with another cache string (another tab's write landed
 * between the two writes of a pair, or a versions write failed): a boot then has none, as with no
 * stored versions. `cache` is the parsed cache (null when absent or unreadable).
 */
export function readDeviceCacheSnapshot(userId: string): { cache: Partial<AppState> | null; versions: Baseline | null } {
  const recordRaw = getItem(tabSyncedKey(userId));
  const cacheRaw = getItem(userCacheKey(userId));
  let cache: Partial<AppState> | null = null;
  try {
    const parsed = cacheRaw ? (JSON.parse(cacheRaw) as unknown) : null;
    if (parsed && typeof parsed === 'object') cache = parsed as Partial<AppState>;
  } catch {
    cache = null;
  }
  return { cache, versions: readVersions(recordRaw, cacheRaw) };
}

/**
 * Takes a snapshot's versions as this tab's, only when the tab holds none for this user yet (a cold
 * boot); a tab already running keeps its own. No versions (none stored, or another cache's) = {}.
 */
export function adoptSnapshotTabSyncedHashes(userId: string, versions: Baseline | null): void {
  if (tabSynced?.userId !== userId) tabSynced = { userId, hashes: versions || {} };
}

/**
 * The one writer of `ascend_user_cache_<id>`: writes the cache string, then this tab's versions
 * with that string's fingerprint, so the cached state keeps the versions it was built on. Tabs
 * share localStorage with no lock, so another tab's pair can interleave with this one; a reader
 * takes a record only with the cache string it names, so whatever order the writes land in, a boot
 * gets a matching pair or no versions, never one tab's versions with another tab's cache. (Two tabs
 * that wrote the very same cache string hold the same state, and either one's versions fit it.)
 * Throws what the cache write throws; a failed versions write leaves the old record, which no
 * longer matches the cache.
 */
export function writeDeviceCache(userId: string, cacheJson: string): void {
  // Read first: a tab with no versions in memory takes the stored ones with the cache they belong to.
  const hashes = tabSyncedHashes(userId);
  localStorage.setItem(userCacheKey(userId), cacheJson);
  const fingerprint = cacheFingerprint(cacheJson);
  lastWrittenCache = { userId, fingerprint };
  try {
    localStorage.setItem(tabSyncedKey(userId), versionsRecord(fingerprint, hashes));
  } catch {
    /* ignore quota errors: without it a cold boot falls back to the baseline alone */
  }
}

/**
 * Stores this tab's versions after its save's diff moved them, so a tab closed right after the save
 * cold-boots with the versions its cached state holds. Only while the cache is still the string this
 * tab last wrote and the stored record is still the one this tab wrote with it (`held`): another tab
 * of the browser may have written the shared cache and versions since, and this tab's versions do
 * not fit that state, even when both tabs' versions were the same. Another tab can still write
 * between this check and the write below; the record written here names this tab's cache string,
 * so with the other tab's cache it is not taken at read time (no versions, the safe fallback), and
 * a later write of the other tab's own pair replaces it.
 */
export function storeTabSyncedHashesOver(userId: string, held: Baseline): void {
  const written = lastWrittenCache;
  if (written?.userId !== userId) return;
  let recordRaw: string | null;
  let cacheRaw: string | null;
  try {
    recordRaw = localStorage.getItem(tabSyncedKey(userId));
    cacheRaw = localStorage.getItem(userCacheKey(userId));
  } catch {
    return;
  }
  if (recordRaw !== versionsRecord(written.fingerprint, held)) return;
  if (cacheRaw === null || cacheFingerprint(cacheRaw) !== written.fingerprint) return;
  try {
    localStorage.setItem(tabSyncedKey(userId), versionsRecord(written.fingerprint, tabSyncedHashes(userId)));
  } catch {
    /* ignore quota errors, as in writeDeviceCache */
  }
}

export function clearTabSyncedHashes(userId: string): void {
  localStorage.removeItem(tabSyncedKey(userId));
  localStorage.removeItem(legacyWriterKey(userId));
  if (tabSynced?.userId === userId) tabSynced = null;
  if (lastWrittenCache?.userId === userId) lastWrittenCache = null;
}
