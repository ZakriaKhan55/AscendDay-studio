// Projects & Goals progress (lib/projectProgress.ts): a project or goal with parts reaches 100% and
// completes / is achieved only when every part is done. Rounding must never finish it early (PG-M1).
import type { Goal, Project, Task } from '../../types';
const { projectProgressOf, goalProgressOf, autoStatusChanges, tasksByProjectId } = await import('../items/projectProgress');
const { lockStatusOf } = await import('../../components/projects/hierarchy');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const created = '2026-11-01T00:00:00.000Z';
const task = (id: string, projectId: string, completed: boolean, subtasks: boolean[] = []): Task => ({
  id,
  title: id,
  projectId,
  priority: 'medium',
  completed,
  subtasks: subtasks.map((done, i) => ({ id: `${id}-s${i}`, title: `s${i}`, completed: done })),
  createdAt: created,
});
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, title: id, status: 'in_progress', createdAt: created, ...over });
const goal = (id: string, over: Partial<Goal> = {}): Goal => ({ id, title: id, status: 'active', createdAt: created, ...over });
const tasksFor = (projectId: string, done: number, open: number) => [
  ...Array.from({ length: done }, (_, i) => task(`${projectId}-d${i}`, projectId, true)),
  ...Array.from({ length: open }, (_, i) => task(`${projectId}-o${i}`, projectId, false)),
];

// Project: 199 of 200 tasks done is 99.5% → shows 99, not 100, and does not complete.
{
  const p = project('p');
  const tasks = tasksFor('p', 199, 1);
  const prog = projectProgressOf(p, tasks);
  assert(prog.percent === 99, `199/200 tasks = 99 (got ${prog.percent})`);
  const changes = autoStatusChanges([], [p], tasks);
  assert(!changes.projects.has('p'), '199/200 tasks: project stays open');
}

// Project: one task with 199 of 200 subtasks done → 99, open.
{
  const p = project('p');
  const tasks = [task('t', 'p', false, [...Array(199).fill(true), false])];
  assert(projectProgressOf(p, tasks).percent === 99, 'one open subtask of 200 keeps the project at 99');
  assert(!autoStatusChanges([], [p], tasks).projects.has('p'), 'one open subtask: project stays open');
}

// Project: every task done → 100 and completes; a done task with all subtasks done counts too.
{
  const p = project('p');
  const tasks = [task('a', 'p', true), task('b', 'p', false, [true, true])];
  assert(projectProgressOf(p, tasks).percent === 100, 'all parts done = 100');
  assert(autoStatusChanges([], [p], tasks).projects.get('p') === 'completed', 'all parts done: project completes');
}

// Project: a completed project whose share drops below every-part-done reopens.
{
  const p = project('p', { status: 'completed' });
  const tasks = tasksFor('p', 199, 1);
  assert(autoStatusChanges([], [p], tasks).projects.get('p') === 'in_progress', 'completed project with an open task reopens');
}

// Normal shares still round as before (only the 100 boundary changed).
{
  const p = project('p');
  assert(projectProgressOf(p, tasksFor('p', 1, 2)).percent === 33, '1/3 = 33');
  assert(projectProgressOf(p, tasksFor('p', 2, 1)).percent === 67, '2/3 = 67');
  assert(projectProgressOf(p, []).percent === 0 && projectProgressOf(p, []).isManual, 'no tasks = manual');
  assert(projectProgressOf(project('m', { manualProgress: 100 }), []).percent === 100, 'manual 100 stays 100');
}

// Goal: [completed, 99%] averages 99.5 → 99, stays Active.
{
  const g = goal('g');
  const done = project('a', { goalId: 'g', status: 'completed' });
  const almost = project('b', { goalId: 'g', manualProgress: 99 });
  const prog = goalProgressOf(g, [done, almost], (p) => projectProgressOf(p, []));
  assert(prog.percent === 99, `[100, 99] = 99 (got ${prog.percent})`);
  assert(!autoStatusChanges([g], [done, almost], []).goals.has('g'), '[100, 99]: goal stays active');
}

// Goal: [100, 100, 99] and ten done + one at 95 stay below 100.
{
  const g = goal('g');
  const three = [project('a', { goalId: 'g', status: 'completed' }), project('b', { goalId: 'g', status: 'completed' }), project('c', { goalId: 'g', manualProgress: 99 })];
  assert(goalProgressOf(g, three, (p) => projectProgressOf(p, [])).percent === 99, '[100,100,99] = 99');
  assert(!autoStatusChanges([g], three, []).goals.has('g'), '[100,100,99]: goal stays active');
  const eleven = [
    ...Array.from({ length: 10 }, (_, i) => project(`d${i}`, { goalId: 'g', status: 'completed' })),
    project('r', { goalId: 'g', manualProgress: 95 }),
  ];
  assert(goalProgressOf(g, eleven, (p) => projectProgressOf(p, [])).percent === 99, '10 done + 1 at 95 = 99');
  assert(!autoStatusChanges([g], eleven, []).goals.has('g'), '10 done + 1 at 95: goal stays active');
}

// Goal: an Achieved goal set back to Active with one project at 99% is not flipped back (no loop).
{
  const g = goal('g', { status: 'active' });
  const projects = [project('a', { goalId: 'g', status: 'completed' }), project('b', { goalId: 'g', manualProgress: 99 })];
  const changes = autoStatusChanges([g], projects, []);
  assert(changes.goals.size === 0, 'goal set back to Active stays Active');
  const achieved = goal('g', { status: 'achieved' });
  assert(autoStatusChanges([achieved], projects, []).goals.get('g') === 'active', 'achieved goal with an open project goes back to Active');
}

// Goal: all projects done (one by its tasks) → 100, achieved.
{
  const g = goal('g');
  const projects = [project('a', { goalId: 'g', status: 'completed' }), project('b', { goalId: 'g' })];
  const tasks = tasksFor('b', 3, 0);
  const changes = autoStatusChanges([g], projects, tasks);
  assert(changes.projects.get('b') === 'completed', 'project b completes from its tasks');
  assert(changes.goals.get('g') === 'achieved', 'goal achieved once every project is done');
}

// In-order goal: a project at 99.5% (rounded) does not unlock the next one.
{
  const g = goal('g', { sequentialMode: true });
  const first = project('a', { goalId: 'g', order: 0 });
  const second = project('b', { goalId: 'g', order: 1 });
  const byProject = tasksByProjectId(tasksFor('a', 199, 1));
  const isComplete = (p: Project) => p.status === 'completed' || projectProgressOf(p, byProject.get(p.id) ?? []).percent === 100;
  const lock = lockStatusOf(second, [g], new Map([['g', [first, second]]]), isComplete);
  assert(lock.isLocked && lock.blockingProject?.id === 'a', 'next project stays locked while the first has an open task');
}

// --- Set progress by hand (manualMode, 1.6.0) ---

// Manual project with every linked task done: the hand % stays, nothing completes it.
{
  const p = project('p', { manualMode: true, manualProgress: 40 });
  const tasks = tasksFor('p', 3, 0);
  const prog = projectProgressOf(p, tasks);
  assert(prog.percent === 40 && prog.isManual, `manual project keeps its hand % (got ${prog.percent})`);
  assert(prog.total === 0 && prog.completed === 0 && prog.linked === 3, 'manual project: tasks linked but not counted');
  assert(!autoStatusChanges([], [p], tasks).projects.has('p'), 'manual project with all tasks done is not completed');
}

// Manual completed project with an open linked task: not reopened.
{
  const p = project('p', { manualMode: true, status: 'completed', manualProgress: 100 });
  const tasks = tasksFor('p', 1, 2);
  assert(!autoStatusChanges([], [p], tasks).projects.has('p'), 'manual completed project with an open task stays completed');
}

// Same projects with manualMode off: the tasks decide again.
{
  const done = tasksFor('p', 3, 0);
  assert(autoStatusChanges([], [project('p', { manualMode: false, manualProgress: 40 })], done).projects.get('p') === 'completed', 'switch off with all tasks done: completes');
  const open = tasksFor('p', 1, 2);
  assert(autoStatusChanges([], [project('p', { manualMode: false, status: 'completed', manualProgress: 100 })], open).projects.get('p') === 'in_progress', 'switch off with an open task: reopens');
  assert(projectProgressOf(project('p'), done).linked === 3, 'auto project counts its linked tasks');
}

// Auto goal: a manual project counts with its hand %, its tasks stay out of the tally.
{
  const g = goal('g');
  const manual = project('m', { goalId: 'g', manualMode: true, manualProgress: 60 });
  const auto = project('a', { goalId: 'g' });
  const tasks = [...tasksFor('m', 2, 0), ...tasksFor('a', 1, 1)];
  const byProject = tasksByProjectId(tasks);
  const prog = goalProgressOf(g, [manual, auto], (p) => projectProgressOf(p, byProject.get(p.id) ?? []));
  assert(prog.percent === 55, `goal = average of 60 and 50 (got ${prog.percent})`);
  assert(prog.totalTasksCount === 2 && prog.completedTasksCount === 1, 'goal tally leaves out the manual project tasks');
}

// G7 (f): auto goal + manual project at 60 + auto project at 100 → 80, not achieved; marking the
// manual project completed → achieved.
{
  const g = goal('g');
  const manual = project('m', { goalId: 'g', manualMode: true, manualProgress: 60 });
  const auto = project('a', { goalId: 'g' });
  const tasks = tasksFor('a', 2, 0);
  const byProject = tasksByProjectId(tasks);
  assert(goalProgressOf(g, [manual, auto], (p) => projectProgressOf(p, byProject.get(p.id) ?? [])).percent === 80, '[60 by hand, 100] = 80');
  const first = autoStatusChanges([g], [manual, auto], tasks);
  assert(first.projects.get('a') === 'completed' && !first.goals.has('g'), 'auto project completes, goal stays active');
  const doneManual = { ...manual, status: 'completed' as const, manualProgress: 100 };
  assert(autoStatusChanges([g], [doneManual, { ...auto, status: 'completed' as const }], tasks).goals.get('g') === 'achieved', 'manual project marked done: goal achieved');
}

// G7 (a)(b): manual goal with 2 projects (one done): hand %, counts kept, no task tally, never achieved.
{
  const g = goal('g', { manualMode: true, manualProgress: 30 });
  const done = project('a', { goalId: 'g', status: 'completed' });
  const open = project('b', { goalId: 'g' });
  const tasks = tasksFor('b', 1, 1);
  const byProject = tasksByProjectId(tasks);
  const prog = goalProgressOf(g, [done, open], (p) => projectProgressOf(p, byProject.get(p.id) ?? []));
  assert(prog.percent === 30 && prog.isManual, `manual goal keeps its hand % (got ${prog.percent})`);
  assert(prog.linkedProjectsCount === 2 && prog.completedProjectsCount === 1, 'manual goal: 1 of 2 projects done');
  assert(prog.totalTasksCount === 0 && prog.completedTasksCount === 0, 'manual goal: no task tally');
  const allDone = [done, { ...open, status: 'completed' as const }];
  assert(!autoStatusChanges([g], allDone, []).goals.has('g'), 'manual active goal with every project done stays active');
}

// G7 (c)(d)(e): manual achieved goal with an open project is not reopened; switched off it is;
// switched off with every project done an active goal is achieved; abandoned never changes.
{
  const projects = [project('a', { goalId: 'g', status: 'completed' }), project('b', { goalId: 'g', manualProgress: 50 })];
  assert(!autoStatusChanges([goal('g', { manualMode: true, status: 'achieved', manualProgress: 100 })], projects, []).goals.has('g'), 'manual achieved goal stays achieved');
  assert(autoStatusChanges([goal('g', { manualMode: false, status: 'achieved' })], projects, []).goals.get('g') === 'active', 'switched off: reopens');
  const allDone = [projects[0], { ...projects[1], status: 'completed' as const }];
  assert(autoStatusChanges([goal('g', { manualMode: false, manualProgress: 10 })], allDone, []).goals.get('g') === 'achieved', 'switched off: achieved');
  assert(!autoStatusChanges([goal('g', { manualMode: true, status: 'abandoned' })], allDone, []).goals.has('g'), 'abandoned manual goal unchanged');
}

// G7 (g): manual goal with 0 projects = the 0-project behaviour.
{
  const a = goalProgressOf(goal('g', { manualMode: true, manualProgress: 70 }), [], (p) => projectProgressOf(p, []));
  const b = goalProgressOf(goal('g', { manualProgress: 70 }), [], (p) => projectProgressOf(p, []));
  assert(JSON.stringify(a) === JSON.stringify(b), 'manual goal with no projects = goal with no projects');
}

// In-order goal: a manual project unlocks the next one only by its status or its hand 100.
{
  const g = goal('g', { sequentialMode: true });
  const first = project('a', { goalId: 'g', order: 0, manualMode: true, manualProgress: 40 });
  const second = project('b', { goalId: 'g', order: 1 });
  const byProject = tasksByProjectId(tasksFor('a', 2, 0));
  const isComplete = (p: Project) => p.status === 'completed' || projectProgressOf(p, byProject.get(p.id) ?? []).percent === 100;
  const byGoal = (f: Project) => new Map([['g', [f, second]]]);
  assert(lockStatusOf(second, [g], byGoal(first), isComplete).isLocked, 'manual project with all tasks done still blocks the next');
  const marked = { ...first, status: 'completed' as const, manualProgress: 100 };
  assert(!lockStatusOf(second, [g], byGoal(marked), isComplete).isLocked, 'manual project marked done unlocks the next');
}

console.log('projectProgress tests passed');
