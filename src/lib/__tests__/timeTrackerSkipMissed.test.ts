// 2026-11-16: "Skip missed" picks today's blocks that have ended without being done or skipped.
// A block ending at 00:00 ends at midnight (1440), so it is never missed during the day.
import type { TimeTrackerBlock } from '@/types';
import { blockEndMinutes, isMissedBlock } from '@/components/views/timeTracker/dayMeta';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const block = (start: string, end: string, extra: Partial<TimeTrackerBlock> = {}) =>
  ({ id: `${start}-${end}`, startTime: start, endTime: end, activityId: 'act-reading', ...extra }) as TimeTrackerBlock;

assert(blockEndMinutes(block('10:00', '11:00')) === 660, 'end 11:00 = 660');
assert(blockEndMinutes(block('23:00', '00:00')) === 1440, 'end 00:00 after a later start = midnight');

const now = 11 * 60 + 30.5; // 11:30:30, minutes carry decimals in the app
assert(isMissedBlock(block('10:00', '11:00'), now), 'ended, open -> missed');
assert(isMissedBlock(block('10:00', '11:30'), now), 'ended exactly before now -> missed');
assert(!isMissedBlock(block('11:00', '12:00'), now), 'current block -> not missed');
assert(!isMissedBlock(block('13:00', '14:00'), now), 'future block -> not missed');
assert(!isMissedBlock(block('10:00', '11:00', { completed: true }), now), 'done -> not missed');
assert(!isMissedBlock(block('10:00', '11:00', { skipped: true }), now), 'skipped -> not missed');
assert(!isMissedBlock(block('23:00', '00:00'), 23 * 60 + 59), 'runs to midnight -> not missed before midnight');

console.log('timeTrackerSkipMissed: all passed');
