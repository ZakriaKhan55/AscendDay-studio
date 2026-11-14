// CodeRabbit phase 6, small behaviour and content fixes (2026-11-14). Pure checks plus source checks
// for page code that needs the whole app to render:
//   CR-04-9  categories with the same name made the same day get a stable " (2)" after the first
//   CR-06-13 a block back on its day (same id) leaves the day's removed ids in any commit
//   CR-05-18 a later switch that kept the place ends the "switch back" default of an older switch
//   CR-06-19 a drag that pauses before release is not a flick
//   CR-05-1  the US 988 Suicide & Crisis Lifeline is listed; SAMHSA says what it is for
//   CR-06-11 / CR-06-15 a choice whose save failed (storage full) wins over the old stored value
//   CR-02-5  the gap countdown uses real instants; CR-02-6 an own plan moved out of the filtered
//   category leaves Discover; CR-02-10 the book text clamp re-measures on width changes; CR-04-1
//   partner stats are kept with their season; CR-06-21 the weekly goals page keeps the reflection
//   window apart from read-only past goals.
import { win } from './harness/dom';
import type { TimeTrackerActivity, TimeTrackerBlock, UserBook } from '@/types';
import { DEFAULT_TIME_TRACKER_STATE } from '@/types';
import { categoryDisplayNames } from '../../components/views/timeTracker/categoryNames';
import { commitTimeTrackerDays } from '../timeTracker/timeTracker';
import { switchBookUnit, unitSwitchDefaults } from '../reading/bookUnits';
import { releaseSpeed } from '../ui/useTabSwipe';
import { CRISIS_LINES } from '../content/crisisLines';
import { getBlockPillPrefs, setBlockPillEnabled } from '../timeTracker/blockPill';
import { getFeedbackPrefs, setFeedbackPrefs } from '../ui/actionFeedback';
import scheduleGapSrc from '../../components/pfc/schedule/ScheduleGap.tsx?raw';
import discoverSrc from '../../components/plans/DiscoverPanel.tsx?raw';
import bookCardSrc from '../../components/reading/BookCard.tsx?raw';
import partnerSrc from '../../components/views/AccountabilityPartner.tsx?raw';
import weeklyGoalsPageSrc from '../../marketing/features/pages/weeklyGoals.tsx?raw';

function assert(condition: unknown, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// CR-04-9
{
  const cat = (id: string, name: string, createdAt?: string): TimeTrackerActivity =>
    ({ id, name, color: '#10b981', icon: 'Circle', createdAt }) as unknown as TimeTrackerActivity;
  const sameDay = [cat('b', 'Deep work', '2026-11-03T09:00:00.000Z'), cat('a', 'Deep work', '2026-11-03T08:00:00.000Z'), cat('c', 'Gym', '2026-11-03T08:00:00.000Z')];
  const names = categoryDisplayNames(sameDay);
  const first = names.get('a')!;
  assert(first.startsWith('Deep work · made '), `older one keeps its made label (${first})`);
  eq(names.get('b'), `${first} (2)`, 'same name, same day: the newer one gets (2)');
  eq(names.get('c'), 'Gym', 'a unique name is untouched');
  // Reordered list: the numbers stay with the same categories.
  const reordered = categoryDisplayNames([sameDay[1], sameDay[2], sameDay[0]]);
  assert(reordered.get('a') === first && reordered.get('b') === `${first} (2)`, 'numbers do not move on reorder');
  // No dates at all: the plain names are told apart too.
  const undated = categoryDisplayNames([cat('x', 'Read'), cat('y', 'read')]);
  assert(undated.get('x') === 'Read' && undated.get('y') === 'read (2)', `undated duplicates (${[...undated.values()]})`);
  // Different days keep only their made labels.
  const apart = categoryDisplayNames([cat('a', 'Deep work', '2026-11-03T08:00:00.000Z'), cat('b', 'Deep work', '2026-11-04T08:00:00.000Z')]);
  assert(![...apart.values()].some((n) => n.endsWith(')')), 'made on different days: no number');
}

// CR-06-13
{
  const DAY = '2026-11-14';
  const block = (id: string, startTime: string, endTime: string): TimeTrackerBlock =>
    ({ id, startTime, endTime, activityId: 'deep-work', createdAt: '2026-11-14T03:00:00.000Z' }) as TimeTrackerBlock;
  const x = block('x', '09:00', '10:00');
  const y = block('y', '11:00', '12:00');
  const start = commitTimeTrackerDays({ ...DEFAULT_TIME_TRACKER_STATE, dailyLogs: { [DAY]: [x, y] } }, { [DAY]: [x, y] }, '2026-11-14T04:00:00.000Z');
  const removed = commitTimeTrackerDays(start, { [DAY]: [y] }, '2026-11-14T05:00:00.000Z');
  eq(removed.dayMeta?.[DAY]?.deletedBlockIds?.join(), 'x', 'removing x remembers it');
  // Restore x with its own id, removing nothing else.
  const back = commitTimeTrackerDays(removed, { [DAY]: [x, y] }, '2026-11-14T06:00:00.000Z');
  eq(back.dayMeta?.[DAY]?.deletedBlockIds?.join(), '', 'x is back: no longer a removed id');
  // A commit that touches no tombstone adds no deletedBlockIds key.
  const plain = commitTimeTrackerDays(start, { [DAY]: [x, { ...y, endTime: '12:30' }] }, '2026-11-14T07:00:00.000Z');
  assert(!('deletedBlockIds' in (plain.dayMeta?.[DAY] || {})), 'plain edit: no deletedBlockIds written');
}

// CR-05-18
{
  const DAY = '2026-11-14';
  const at = (h: number) => new Date(2026, 10, 14, h).toISOString();
  const b = { id: 'b', title: 'T', author: 'A', status: 'reading', pointsAwarded: 0, addedAt: at(0), unit: 'pages', currentAmount: 100, totalAmount: 300 } as UserBook;
  const toChapters = switchBookUnit(b, { unit: 'chapters', current: 0, total: 15 }, at(9), DAY);
  eq(toChapters.unitSwitches?.length, 1, '100 pages -> 0 chapters is kept');
  eq(unitSwitchDefaults(toChapters, 'pages').current, 100, 'switching straight back still offers 100 pages');
  // The user confirms 0 pages instead: the place does not move, so no record is added.
  const backAtZero = switchBookUnit(toChapters, { unit: 'pages', current: 0, total: 300 }, at(10), DAY);
  eq(backAtZero.unitSwitches?.length, 1, 'a switch that keeps the place adds no record');
  eq(unitSwitchDefaults(backAtZero, 'chapters').current, 0, 'next switch to chapters offers 0, not the old 100 pages');
  // A record saved before toUnit existed keeps the old rule.
  const legacy = { ...toChapters, unitSwitches: [{ date: DAY, at: at(9), pagesBefore: 100, pagesAfter: 0 }] } as UserBook;
  eq(unitSwitchDefaults(legacy, 'pages').current, 100, 'legacy record: switch back still offered');
}

// CR-06-19
{
  const samples = [
    { x: 300, t: 1000 },
    { x: 260, t: 1050 },
  ];
  assert(Math.abs(releaseSpeed(samples, 1060) - -0.8) < 1e-9, 'released right after moving: 0.8 px/ms to the left');
  eq(releaseSpeed(samples, 2050), 0, 'held still for a second before release: no flick speed');
  eq(releaseSpeed(samples, 1050 + 80), -0.8, 'within the flick window: still a flick');
  eq(releaseSpeed([{ x: 10, t: 5 }], 6), 0, 'one sample: no speed');
}

// CR-05-1
{
  const line988 = CRISIS_LINES.find((l) => l.tel === '988');
  assert(line988 && line988.place === 'US' && line988.number === '988' && line988.name === 'Suicide & Crisis Lifeline', '988 listed for the US');
  const us = CRISIS_LINES.filter((l) => l.place === 'US');
  eq(us[0]?.tel, '988', 'the crisis line comes before the treatment-referral line');
  eq(CRISIS_LINES.find((l) => l.name === 'SAMHSA Helpline')?.note, 'treatment referral and information', 'SAMHSA says what it is for');
  assert(!CRISIS_LINES.some((l) => /24|hour/i.test(l.note || '')), 'no opening hours claimed');
}

// CR-06-11 / CR-06-15: storage full = setItem throws while getItem still reads the old value.
{
  const storage = win.localStorage as Storage;
  const realSet = storage.setItem;
  const full = () => {
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
  };
  const roomy = () => {
    storage.setItem = realSet;
  };

  setBlockPillEnabled(true);
  eq(getBlockPillPrefs().enabled, true, 'pill: on and saved');
  full();
  setBlockPillEnabled(false);
  eq(getBlockPillPrefs().enabled, false, 'pill: a failed save still turns it off until reload');
  roomy();
  setBlockPillEnabled(true);
  eq(getBlockPillPrefs().enabled, true, 'pill: a working save takes over');
  storage.setItem('ascend_block_pill', JSON.stringify({ v: 1, enabled: false, pos: {} }));
  eq(getBlockPillPrefs().enabled, false, 'pill: after a working save, storage is read again (another tab)');

  setFeedbackPrefs({ tick: 'vibration' });
  eq(getFeedbackPrefs().tick, 'vibration', 'feedback: saved');
  full();
  setFeedbackPrefs({ tick: 'none' });
  eq(getFeedbackPrefs().tick, 'none', 'feedback: a failed save still holds the new choice');
  roomy();
  setFeedbackPrefs({ swipe: 'none' });
  const saved = JSON.parse(storage.getItem('ascend_feedback_prefs') || '{}');
  assert(saved.tick === 'none' && saved.swipe === 'none', `feedback: the working save keeps both choices (${JSON.stringify(saved)})`);
}

// Source checks (pages that need the whole app to render).
{
  assert(/blockIntervalMs\(nextBlock, day\)\.startMs - now\.getTime\(\)/.test(scheduleGapSrc), 'CR-02-5: gap countdown from real instants');
  assert(!/getHours\(\) \* 3600/.test(scheduleGapSrc), 'CR-02-5: no wall-clock seconds left');

  // CR-02-6 is checked by behaviour in discoverVisible.test.ts; the page must use that rule.
  assert(/discoverVisiblePlans\(plans, ownById, filters\)/.test(discoverSrc), 'CR-02-6: Discover cards go through discoverVisiblePlans');

  assert(/useClampOverflow\(ref, !expanded, text \?\? ''\)/.test(bookCardSrc), 'CR-02-10: book text uses the width-aware clamp hook');
  assert(!/useLayoutEffect/.test(bookCardSrc), 'CR-02-10: the one-time measure is gone');

  assert(/const season = getSeasonNumber\(leagueNow\(\)\)/.test(partnerSrc), 'CR-04-1: the season on screen is read each render');
  assert(/\[partnerName, getPartnerProfileStats, statsAttempt, season\]/.test(partnerSrc), 'CR-04-1: a new season fetches the stats again');
  assert(/partnerStats\.season === season \? partnerStats : null/.test(partnerSrc), "CR-04-1: another season's stats are never shown");

  const text = weeklyGoalsPageSrc.replace(/\s+/g, ' ');
  assert(text.includes('Past weeks’ goals are kept to look back on and can’t be edited; last week’s reflection stays open until Monday ends.'), 'CR-06-21: read-only past goals, reflection open through Monday');
  assert(!text.includes('past weeks are kept to look back on and can’t be edited'), 'CR-06-21: old sentence gone');
}

console.log('crP6Behaviour: all checks passed');
