// The device cache and the row versions stored with it are a pair across the tabs of one browser
// (CodeRabbit: "tabVersions writer check is not atomic across tabs"). localStorage has no lock, so
// two tabs' writes (cache, then versions) can land in any order; a read must give a matching pair
// or no versions (the fallback), never one tab's versions with another tab's cache.
//   P1  every order of tab A's and tab B's four writes (all 24): matching pair or fallback; the
//       interleaving A-cache, B-cache, B-versions, A-versions gives the fallback; in-order writes
//       give the last writer's pair. Same through the snapshot and the lazy read.
//   P2  a legacy record (plain Baseline, before v2) is still taken; the next write replaces it.
//   P3  storeTabSyncedHashesOver after another tab's cache write (before or during it) never leaves
//       a mismatched pair that a read takes.
import type { Baseline } from '../tabVersions';

const store = new Map<string, string>();
/** Runs before a setItem is applied (a write of another tab landing just before this one). */
let beforeSet: ((key: string) => void) | null = null;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    const hook = beforeSet;
    beforeSet = null;
    hook?.(k);
    store.set(k, String(v));
  },
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

const {
  cacheFingerprint,
  clearTabSyncedHashes,
  readDeviceCacheSnapshot,
  setTabSyncedHashes,
  storeTabSyncedHashesOver,
  tabSyncedHashes,
  writeDeviceCache,
} = await import('../tabVersions');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const UID = 'u1';
const CACHE = `ascend_user_cache_${UID}`;
const VERSIONS = `ascend_sync_tab_synced_${UID}`;
const WRITER = `ascend_sync_tab_synced_writer_${UID}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const A = { cache: JSON.stringify({ habits: [{ id: 'h1', name: 'A' }] }), versions: { habits: { h1: 'hash-a' } } as Baseline };
const B = { cache: JSON.stringify({ habits: [{ id: 'h1', name: 'B' }] }), versions: { habits: { h1: 'hash-b' } } as Baseline };

function reset() {
  store.clear();
  clearTabSyncedHashes(UID);
}

/** The versions a cold boot of a new tab gets by the lazy read (no versions in memory for UID). */
function lazyRead(): Baseline {
  setTabSyncedHashes('someone-else', {});
  return tabSyncedHashes(UID);
}

/** The two setItem calls a tab's writeDeviceCache makes, captured without applying them. */
function capturedWrites(tab: typeof A): [string, string][] {
  reset();
  setTabSyncedHashes(UID, tab.versions);
  writeDeviceCache(UID, tab.cache);
  const writes: [string, string][] = [
    [CACHE, store.get(CACHE)!],
    [VERSIONS, store.get(VERSIONS)!],
  ];
  reset();
  return writes;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

/** The result of one read: a matching pair (whose) or the fallback; throws on a mismatched pair. */
function classify(cacheRaw: string | null, versions: Baseline | null, what: string): 'A' | 'B' | 'fallback' {
  if (versions === null || same(versions, {})) return 'fallback';
  if (cacheRaw === A.cache && same(versions, A.versions)) return 'A';
  if (cacheRaw === B.cache && same(versions, B.versions)) return 'B';
  throw new Error(`Assertion failed: ${what}: mismatched pair taken (cache ${cacheRaw}, versions ${JSON.stringify(versions)})`);
}

// P1: every order of the four writes.
{
  const [a1, a2] = capturedWrites(A);
  const [b1, b2] = capturedWrites(B);
  const named = new Map([[a1, 'A-cache'], [a2, 'A-versions'], [b1, 'B-cache'], [b2, 'B-versions']]);
  const outcomes = new Map<string, string>();
  for (const order of permutations([a1, a2, b1, b2])) {
    const label = order.map((w) => named.get(w)).join(', ');
    reset();
    for (const [key, value] of order) store.set(key, value);
    const snapshot = readDeviceCacheSnapshot(UID);
    const cacheRaw = store.get(CACHE) ?? null;
    assert(same(snapshot.cache, JSON.parse(cacheRaw!)), `P1 ${label}: the snapshot's cache is the stored cache`);
    const viaSnapshot = classify(cacheRaw, snapshot.versions, `P1 snapshot ${label}`);
    const viaLazy = classify(cacheRaw, lazyRead(), `P1 lazy read ${label}`);
    assert(viaSnapshot === viaLazy, `P1 ${label}: the snapshot and the lazy read agree`);
    outcomes.set(label, viaSnapshot);
  }
  assert(outcomes.size === 24, 'P1: all 24 orders checked');
  assert(outcomes.get('A-cache, B-cache, B-versions, A-versions') === 'fallback', "P1: A's versions over B's cache are not taken");
  assert(outcomes.get('B-cache, A-cache, A-versions, B-versions') === 'fallback', "P1: B's versions over A's cache are not taken");
  assert(outcomes.get('A-cache, A-versions, B-cache, B-versions') === 'B', 'P1: in-order writes give the last pair (B)');
  assert(outcomes.get('B-cache, B-versions, A-cache, A-versions') === 'A', 'P1: in-order writes give the last pair (A)');
  assert(outcomes.get('A-cache, B-cache, A-versions, B-versions') === 'B', "P1: B's pair stands when its versions land last over its cache");
}
console.log("  ok  P1 every order of two tabs' cache + versions writes: matching pair or fallback");

// P2: a legacy record is taken as before (with or without a cache), and the next write is v2.
{
  reset();
  const legacy = { tasks: { t1: 'legacy-hash' } };
  store.set(CACHE, A.cache);
  store.set(VERSIONS, JSON.stringify(legacy));
  assert(same(readDeviceCacheSnapshot(UID).versions, legacy), 'P2: the snapshot takes a legacy record');
  assert(same(lazyRead(), legacy), 'P2: the lazy read takes a legacy record');
  store.delete(CACHE);
  assert(same(readDeviceCacheSnapshot(UID).versions, legacy), 'P2: a legacy record without a cache is taken too (as before)');

  store.set(CACHE, A.cache);
  clearTabSyncedHashes(UID);
  store.set(VERSIONS, JSON.stringify(legacy));
  writeDeviceCache(UID, B.cache); // a new tab's first write: it carries the legacy versions on
  const record = JSON.parse(store.get(VERSIONS)!);
  assert(record.v === 2 && record.cache === cacheFingerprint(B.cache) && same(record.hashes, legacy), 'P2: the next write stores v2 for its cache');
  assert(same(readDeviceCacheSnapshot(UID).versions, legacy), 'P2: and it reads back');

  // Unknown or broken records are not taken.
  store.set(VERSIONS, JSON.stringify({ v: 3, cache: cacheFingerprint(B.cache), hashes: legacy }));
  assert(readDeviceCacheSnapshot(UID).versions === null, 'P2: a later format is not taken');
  store.set(VERSIONS, '{broken');
  assert(readDeviceCacheSnapshot(UID).versions === null, 'P2: an unreadable record is not taken');
}
console.log('  ok  P2 legacy records taken; next write is v2');

// P3: storeTabSyncedHashesOver after another tab's cache write.
{
  const held = A.versions;
  const moved = { habits: { h1: 'hash-a-moved' } };

  // Own pair still in place: rewritten with the moved versions, paired with this tab's cache.
  reset();
  setTabSyncedHashes(UID, held);
  writeDeviceCache(UID, A.cache);
  setTabSyncedHashes(UID, moved);
  storeTabSyncedHashesOver(UID, held);
  assert(same(readDeviceCacheSnapshot(UID).versions, moved), 'P3: over its own pair, the moved versions are stored');

  // B wrote only its cache (its versions not yet): A does not store; nothing mismatched is taken.
  reset();
  setTabSyncedHashes(UID, held);
  writeDeviceCache(UID, A.cache);
  store.set(CACHE, B.cache);
  const before = store.get(VERSIONS);
  setTabSyncedHashes(UID, moved);
  storeTabSyncedHashesOver(UID, held);
  assert(store.get(VERSIONS) === before, "P3: not stored over another tab's cache");
  assert(readDeviceCacheSnapshot(UID).versions === null, "P3: A's versions are not taken with B's cache");

  // B wrote its whole pair: left alone, B's pair reads back.
  reset();
  setTabSyncedHashes(UID, held);
  writeDeviceCache(UID, A.cache);
  store.set(CACHE, B.cache);
  store.set(VERSIONS, JSON.stringify({ v: 2, cache: cacheFingerprint(B.cache), hashes: B.versions }));
  setTabSyncedHashes(UID, moved);
  storeTabSyncedHashesOver(UID, held);
  assert(same(readDeviceCacheSnapshot(UID).versions, B.versions), "P3: another tab's pair is not overwritten");

  // B's pair holds the same versions as A held: still B's (A did not write that cache).
  reset();
  setTabSyncedHashes(UID, held);
  writeDeviceCache(UID, A.cache);
  store.set(CACHE, B.cache);
  const bSame = JSON.stringify({ v: 2, cache: cacheFingerprint(B.cache), hashes: held });
  store.set(VERSIONS, bSame);
  setTabSyncedHashes(UID, moved);
  storeTabSyncedHashesOver(UID, held);
  assert(store.get(VERSIONS) === bSame, "P3: another tab's equal versions are not overwritten");

  // B's cache lands between A's check and A's write: A's record names A's cache, so it is not
  // taken with B's; B's versions landing after restore B's pair.
  reset();
  setTabSyncedHashes(UID, held);
  writeDeviceCache(UID, A.cache);
  setTabSyncedHashes(UID, moved);
  beforeSet = (key) => {
    assert(key === VERSIONS, 'P3: the race injects before the versions write');
    store.set(CACHE, B.cache);
  };
  storeTabSyncedHashesOver(UID, held);
  assert(beforeSet === null, 'P3: the race ran');
  assert(readDeviceCacheSnapshot(UID).versions === null, "P3: a write racing B's cache is not taken with it");
  assert(same(lazyRead(), {}), 'P3: the lazy read falls back too');
  store.set(VERSIONS, JSON.stringify({ v: 2, cache: cacheFingerprint(B.cache), hashes: B.versions }));
  assert(same(readDeviceCacheSnapshot(UID).versions, B.versions), "P3: B's own versions then pair with its cache");

  // Nothing written by this tab yet (e.g. a fresh tab): never stores.
  reset();
  store.set(CACHE, A.cache);
  store.set(VERSIONS, JSON.stringify({ v: 2, cache: cacheFingerprint(A.cache), hashes: held }));
  setTabSyncedHashes(UID, moved);
  storeTabSyncedHashesOver(UID, held);
  assert(same(readDeviceCacheSnapshot(UID).versions, held), 'P3: a tab that wrote no cache does not store');
}
console.log('  ok  P3 storeTabSyncedHashesOver never leaves a taken mismatched pair');

// Clear removes the versions and a leftover legacy writer key.
{
  reset();
  store.set(VERSIONS, '{}');
  store.set(WRITER, 'tab-B');
  clearTabSyncedHashes(UID);
  assert(!store.has(VERSIONS) && !store.has(WRITER), 'clear removes the versions and the legacy writer key');
}
console.log('  ok  clear removes the legacy writer key');
console.log('tabVersionsPairing: OK');
