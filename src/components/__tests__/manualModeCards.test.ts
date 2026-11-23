// Cards of a goal or project set by hand (projects/ProjectCard.tsx, GoalCard.tsx): the detail line,
// the Update button even with linked parts, Completed/Achieved allowed, no "add a part" nudge.
// Rendered to a string in Node; the dom harness only gives module-level code a document.
import '../../lib/__tests__/harness/dom';
import type { Goal, Project } from '@/types';
const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { ProjectCard } = await import('../projects/ProjectCard');
const { GoalCard } = await import('../projects/GoalCard');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const noop = () => {};
const created = '2026-11-01T00:00:00.000Z';
const unlocked = { isLocked: false, isSequentialGoal: false };
const projectHtml = (project: Project, prog: { total: number; completed: number; linked: number; percent: number; isManual: boolean }) =>
  renderToString(
    createElement(ProjectCard, {
      project, prog, lock: unlocked, goalName: null, today: '2026-11-22',
      onStatusChange: noop, onOpenGoal: noop, onOpenTasks: noop, onAddTask: noop, onUpdateProgress: noop, onEdit: noop, onDelete: noop,
    })
  );
const goalHtml = (goal: Goal, prog: { linkedProjectsCount: number; completedProjectsCount: number; totalTasksCount: number; completedTasksCount: number; percent: number; isManual: boolean }) =>
  renderToString(
    createElement(GoalCard, { goal, prog, today: '2026-11-22', onStatusChange: noop, onOpenProjects: noop, onAddProject: noop, onUpdateProgress: noop, onEdit: noop, onDelete: noop })
  );
const text = (html: string) => html.replace(/<!-- -->/g, '');
const completedEnabled = (html: string) => /<option value="completed">Completed<\/option>/.test(html);
const achievedEnabled = (html: string) => /<option value="achieved">Achieved<\/option>/.test(html);

const p = (over: Partial<Project> = {}): Project => ({ id: 'p', title: 'P', status: 'in_progress', createdAt: created, ...over });
const g = (over: Partial<Goal> = {}): Goal => ({ id: 'g', title: 'G', status: 'active', createdAt: created, ...over });

{
  const html = text(projectHtml(p({ manualMode: true, manualProgress: 40 }), { total: 0, completed: 0, linked: 3, percent: 40, isManual: true }));
  assert(html.includes('You set this by hand · 3 tasks linked'), 'manual project with tasks: detail line');
  assert(html.includes('>3 tasks<'), 'manual project: tasks button counts linked tasks');
  assert(completedEnabled(html), 'manual project with tasks: Completed allowed');
  assert(html.includes('Update'), 'manual project with tasks: Update shows');
  const one = text(projectHtml(p({ manualMode: true }), { total: 0, completed: 0, linked: 1, percent: 0, isManual: true }));
  assert(one.includes('You set this by hand · 1 task linked'), 'one linked task: singular');
  const none = text(projectHtml(p({ manualMode: true }), { total: 0, completed: 0, linked: 0, percent: 0, isManual: true }));
  assert(none.includes('You set this by hand') && !none.includes('tasks linked') && !none.includes('This project has no tasks yet'), 'manual, no tasks: no nudge');
  const auto = text(projectHtml(p(), { total: 2, completed: 1, linked: 2, percent: 50, isManual: false }));
  assert(auto.includes('1 of 2 tasks done') && !completedEnabled(auto) && !auto.includes('Update'), 'auto project with tasks unchanged');
  const autoEmpty = text(projectHtml(p(), { total: 0, completed: 0, linked: 0, percent: 0, isManual: true }));
  assert(autoEmpty.includes('No tasks yet, so you update it yourself') && autoEmpty.includes('This project has no tasks yet'), 'auto, no tasks unchanged');
}

{
  const html = text(goalHtml(g({ manualMode: true, manualProgress: 30 }), { linkedProjectsCount: 3, completedProjectsCount: 2, totalTasksCount: 0, completedTasksCount: 0, percent: 30, isManual: true }));
  assert(html.includes('You set this by hand · 2 of 3 projects done'), 'manual goal with projects: detail line');
  assert(achievedEnabled(html) && html.includes('Update'), 'manual goal: Achieved allowed, Update shows');
  const one = text(goalHtml(g({ manualMode: true }), { linkedProjectsCount: 1, completedProjectsCount: 1, totalTasksCount: 0, completedTasksCount: 0, percent: 0, isManual: true }));
  assert(one.includes('You set this by hand · 1 of 1 project done'), 'one project: singular');
  const none = text(goalHtml(g({ manualMode: true }), { linkedProjectsCount: 0, completedProjectsCount: 0, totalTasksCount: 0, completedTasksCount: 0, percent: 0, isManual: true }));
  assert(none.includes('You set this by hand') && !none.includes('A goal without a plan'), 'manual goal, no projects: no nudge');
  assert(none.includes('Add project'), 'active manual goal, no projects: footer offers Add project');
  const autoNone = text(goalHtml(g(), { linkedProjectsCount: 0, completedProjectsCount: 0, totalTasksCount: 0, completedTasksCount: 0, percent: 0, isManual: true }));
  assert(autoNone.includes('A goal without a plan') && autoNone.split('Add project').length === 2, 'active auto goal, no projects: only the nudge offers Add project');
  const auto = text(goalHtml(g(), { linkedProjectsCount: 2, completedProjectsCount: 1, totalTasksCount: 4, completedTasksCount: 1, percent: 50, isManual: false }));
  assert(auto.includes('1 of 2 projects done · 1/4 tasks') && !achievedEnabled(auto), 'auto goal unchanged');
}


// Status menu of an automatic item whose parts are all done: a status the store's auto-status
// effect would change straight back (a second quick write of the same row) is not offered.
{
  // The selected option carries selected="", so only the disabled attribute decides.
  const optionEnabled = (html: string, value: string) => {
    const tag = html.match(new RegExp(`<option value="${value}"[^>]*>`));
    return Boolean(tag) && !/disabled/.test(tag![0]);
  };
  const done = text(projectHtml(p({ status: 'completed' }), { total: 2, completed: 2, linked: 2, percent: 100, isManual: false }));
  assert(optionEnabled(done, 'completed'), 'auto project, all tasks done: Completed offered');
  for (const v of ['not_started', 'in_progress', 'on_hold']) assert(!optionEnabled(done, v), `auto project, all tasks done: ${v} not offered`);
  assert(done.includes('In progress (reopen a task first)'), 'auto project, all tasks done: says why');
  const open = text(projectHtml(p(), { total: 2, completed: 1, linked: 2, percent: 50, isManual: false }));
  for (const v of ['not_started', 'in_progress', 'on_hold']) assert(optionEnabled(open, v), `auto project, open task: ${v} offered`);
  const byHand = text(projectHtml(p({ manualMode: true, status: 'completed', manualProgress: 100 }), { total: 0, completed: 0, linked: 2, percent: 100, isManual: true }));
  for (const v of ['not_started', 'in_progress', 'on_hold']) assert(optionEnabled(byHand, v), `project set by hand at 100: ${v} offered`);

  const gp = { linkedProjectsCount: 2, completedProjectsCount: 2, totalTasksCount: 0, completedTasksCount: 0, percent: 100, isManual: false };
  const achieved = text(goalHtml(g({ status: 'achieved' }), gp));
  assert(!optionEnabled(achieved, 'active') && optionEnabled(achieved, 'achieved') && optionEnabled(achieved, 'abandoned'), 'auto goal, all projects done: Active not offered');
  assert(achieved.includes('Active (reopen a project first)'), 'auto goal, all projects done: says why');
  const abandoned = text(goalHtml(g({ status: 'abandoned' }), gp));
  assert(!optionEnabled(abandoned, 'active') && optionEnabled(abandoned, 'achieved'), 'abandoned auto goal, all projects done: Achieved offered, Active not');
  const openGoal = text(goalHtml(g(), { ...gp, completedProjectsCount: 1, percent: 50 }));
  assert(optionEnabled(openGoal, 'active') && !optionEnabled(openGoal, 'achieved'), 'auto goal, open project: Active offered, Achieved waits');
  const goalByHand = text(goalHtml(g({ manualMode: true, status: 'achieved', manualProgress: 100 }), { ...gp, isManual: true }));
  assert(optionEnabled(goalByHand, 'active'), 'goal set by hand at 100: Active offered');
}

console.log('manualModeCards: all assertions passed');
// The card modules start app timers on import (like the other component tests): end the process.
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
