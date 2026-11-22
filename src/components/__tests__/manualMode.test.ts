// "Set progress by hand" helpers (components/projects/hierarchy.ts): the switch-on seed, the
// switch-off outcome line, and the status patches on a manual goal or project (callers pass
// hasParts && !manualMode, so a manual item moves its % with the status).
import type { Goal, Project } from '../../types';
const {
  projectModePatch,
  goalModePatch,
  projectSwitchOffOutcome,
  goalSwitchOffOutcome,
  projectStatusPatch,
  goalStatusPatch,
  projectSaveOutcomeFields,
  goalSaveOutcomeFields,
  REOPENED_PERCENT,
} = await import('../projects/hierarchy');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const created = '2026-11-01T05:00:00+05:00';
const project = (over: Partial<Project> = {}): Project => ({ id: 'p', title: 'p', status: 'in_progress', createdAt: created, ...over });
const goal = (over: Partial<Goal> = {}): Goal => ({ id: 'g', title: 'g', status: 'active', createdAt: created, ...over });

// Project switch on: seeds the shown % (not the stale manualProgress), 100 when completed.
assert(same(projectModePatch(project({ manualProgress: 0 }), true, 67), { manualMode: true, manualProgress: 67 }), 'project on: shown %');
assert(same(projectModePatch(project({ status: 'completed', manualProgress: 0 }), true, 80), { manualMode: true, manualProgress: 100 }), 'completed project on: 100');
assert(same(projectModePatch(project({ manualMode: true }), true, 50), {}), 'project already on: nothing');
assert(same(projectModePatch(project(), false, 50), {}), 'project already off: nothing');
assert(same(projectModePatch(project({ manualMode: true, manualProgress: 40 }), false, 90), { manualMode: false }), 'project off: hand % left as it is');
assert(same(projectModePatch(null, true, 0), {}), 'new project: nothing (createProject takes manualMode)');

// Goal switch on: shown % (live rows hold a stale 0), 100 when achieved.
assert(same(goalModePatch(goal({ manualProgress: 0 }), true, 55), { manualMode: true, manualProgress: 55 }), 'goal on: shown %');
assert(same(goalModePatch(goal({ status: 'achieved', manualProgress: 0 }), true, 90), { manualMode: true, manualProgress: 100 }), 'achieved goal on: 100');
assert(same(goalModePatch(goal({ manualMode: true }), true, 10), {}), 'goal already on: nothing');
assert(same(goalModePatch(goal({ manualMode: true, manualProgress: 40 }), false, 0), { manualMode: false }), 'goal off: hand % left as it is');

// Project switch-off outcome.
assert(projectSwitchOffOutcome(100, 'in_progress') === 'complete', 'all tasks done: completes');
assert(projectSwitchOffOutcome(100, 'on_hold') === 'complete', 'on hold with all tasks done: completes');
assert(projectSwitchOffOutcome(60, 'completed') === 'reopen', 'completed with an open task: reopens');
assert(projectSwitchOffOutcome(60, 'in_progress') === 'none', 'open stays open');
assert(projectSwitchOffOutcome(100, 'completed') === 'none', 'completed stays completed');
assert(projectSwitchOffOutcome(null, 'completed') === 'none', 'no tasks: nothing changes');

// Goal switch-off outcome.
assert(goalSwitchOffOutcome(100, 'active') === 'complete', 'all projects done: achieved');
assert(goalSwitchOffOutcome(50, 'achieved') === 'reopen', 'achieved with an open project: active');
assert(goalSwitchOffOutcome(50, 'active') === 'none', 'active stays active');
assert(goalSwitchOffOutcome(100, 'achieved') === 'none', 'achieved stays achieved');
assert(goalSwitchOffOutcome(100, 'abandoned') === 'none' && goalSwitchOffOutcome(0, 'abandoned') === 'none', 'abandoned: nothing');
assert(goalSwitchOffOutcome(null, 'active') === 'none', 'no projects: nothing');

// Status patches on manual items (hasParts && !manualMode = false).
assert(same(goalStatusPatch(goal({ manualMode: true, manualProgress: 40 }), 'achieved', false), { status: 'achieved', manualProgress: 100 }), 'manual goal Achieved: 100');
assert(
  same(goalStatusPatch(goal({ manualMode: true, status: 'achieved', manualProgress: 100 }), 'active', false), { status: 'active', manualProgress: REOPENED_PERCENT }),
  'manual goal Achieved taken back: 95'
);
assert(same(projectStatusPatch(project({ manualMode: true, manualProgress: 20 }), 'completed', false), { status: 'completed', manualProgress: 100 }), 'manual project Completed: 100');
assert(
  same(projectStatusPatch(project({ manualMode: true, status: 'completed', manualProgress: 100 }), 'in_progress', false), { status: 'in_progress', manualProgress: REOPENED_PERCENT }),
  'manual project Completed taken back: 95'
);
// Switch on + status change in one save: the patch reads the seeded %, so 100 → 95.
{
  const editing = project({ status: 'completed', manualProgress: 0 });
  const mode = projectModePatch(editing, true, 100);
  const status = projectStatusPatch({ ...editing, ...mode }, 'in_progress', false);
  assert(same({ ...mode, ...status }, { manualMode: true, manualProgress: REOPENED_PERCENT, status: 'in_progress' }), 'on + reopen in one save: 95');
}

// Save outcome: runs whenever the saved item ends up automatic, also when it already was (on →
// Completed → off in the form leaves status 'completed' with manualMode false and no mode change).
assert(same(projectSaveOutcomeFields(50, false, 'completed'), { status: 'in_progress' }), 'auto project, open task, saved Completed: In progress');
assert(same(projectSaveOutcomeFields(100, false, 'on_hold'), { status: 'completed' }), 'auto project, all done, saved On hold: Completed');
assert(same(projectSaveOutcomeFields(50, true, 'completed'), {}), 'project set by hand: status as picked');
assert(same(projectSaveOutcomeFields(null, false, 'completed'), {}), 'project without tasks: status as picked');
assert(same(goalSaveOutcomeFields(50, false, 'achieved'), { status: 'active' }), 'auto goal, open project, saved Achieved: Active');
assert(same(goalSaveOutcomeFields(100, false, 'active'), { status: 'achieved' }), 'auto goal, all done, saved Active: Achieved');
assert(same(goalSaveOutcomeFields(50, true, 'achieved'), {}) && same(goalSaveOutcomeFields(50, false, 'abandoned'), {}), 'goal by hand / abandoned: as picked');

console.log('manualMode helpers: all assertions passed');
