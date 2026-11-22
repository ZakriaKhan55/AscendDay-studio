// Hook test (real useAppState + in-process fake Supabase, see harness/): "Set progress by hand"
// (manualMode, 1.6.0) on projects and goals.
//   T26  a project created with manualMode: its linked task, ticked, neither completes it nor moves
//        its hand % (state + row, row manual_mode = true); an old-client write (1.5.x row without
//        manual_mode, newer updated_at) keeps manual_mode = true; turning the switch off lets the
//        project complete (state + row), saved like the form does (outcome status in the same write).
//   T27  a goal created with manualMode and an auto project with one task: ticking the task
//        completes the project but the goal stays active (row manual_mode = true); an old-client
//        write keeps the flag; turning the switch off achieves the goal (outcome in the same write).
//   T28  an automatic project with an open task saved as Completed (form: on → Completed → off, so
//        no mode change) and an automatic goal with an open project saved as Achieved: the save
//        lands as In progress / Active in ONE write of the row, never uploading Completed/Achieved.
import { bootHook, story, until, quiet, rows, assert, pass, server, UID, fake } from './harness/bootHook';
import { goalModePatch, goalSaveOutcomeFields, goalStatusPatch, projectModePatch, projectSaveOutcomeFields, projectStatusPatch } from '@/components/projects/hierarchy';

const blobAt = '2026-11-01T00:00:00.000Z';
const row = (table: string, id: string) => rows(table).find((r) => r.id === id);
/** A 1.5.x client's upsert: its toRow has no manual_mode key; a newer updated_at, a new title. */
const oldClientWrite = (table: string, id: string, title: string) => {
  const current = { ...row(table, id) };
  delete current.manual_mode;
  delete current.server_updated_at;
  const res = server.upsert(table, [{ ...current, title, updated_at: server.nowIso() }], 'old-client');
  assert(res.status === 201 && res.body.length === 1, `${table}: old-client write stored`);
};

await story('manualMode.hook (Set progress by hand on projects and goals)', async () => {
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await until(() => h.s().isServerDataApplied, 'server data applied');
  await quiet(1500);

  // T26 project
  const p = h.s().createProject({ title: 'HandProject', manualProgress: 30, manualMode: true });
  const project = () => h.s().state.projects.find((x) => x.id === p.id);
  await until(() => row('projects', p.id)?.manual_mode === true, 'T26: project row has manual_mode = true', 5000);
  h.s().createTask({ title: 'HandTask', projectId: p.id });
  const task = () => h.s().state.tasks.find((t) => t.title === 'HandTask');
  await until(() => task() && row('tasks', task()!.id), 'T26: linked task reached tasks', 5000);
  h.s().toggleTaskCompleted(task()!.id);
  await until(() => row('tasks', task()!.id)?.completed === true, 'T26: task tick reached tasks', 5000);
  await quiet(1500);
  assert(project()?.status === 'not_started' && project()?.manualProgress === 30, 'T26: manual project not completed, hand % kept (state)');
  assert(row('projects', p.id)?.status === 'not_started' && Number(row('projects', p.id)?.manual_progress) === 30, 'T26: manual project not completed (row)');

  oldClientWrite('projects', p.id, 'HandProject renamed');
  await until(() => project()?.title === 'HandProject renamed', 'T26: old-client rename reached the state');
  assert(row('projects', p.id)?.manual_mode === true, 'T26: old-client write keeps manual_mode = true (row)');
  assert(project()?.manualMode === true, 'T26: still by hand after the old-client write (state)');
  await quiet(1000);
  assert(project()?.status === 'not_started', 'T26: old-client write did not complete it here');

  // Switch off as the form saves it: the outcome status rides in the same write (the effect then has
  // nothing left to change, so no second quick write of the row; see the deferred race note).
  h.s().updateProject(p.id, { manualMode: false, status: 'completed' });
  await until(() => project()?.status === 'completed' && project()?.completedAt, 'T26: switch off → completed with completedAt (state)');
  await until(() => row('projects', p.id)?.status === 'completed' && row('projects', p.id)?.manual_mode === false, 'T26: completed, manual_mode false (row)', 5000);
  await quiet(1000);
  assert(row('projects', p.id)?.status === 'completed' && project()?.status === 'completed', 'T26: state and row agree after the switch off');
  pass('T26 project by hand: tick moves nothing, old-client write keeps the flag, switch off completes');

  // T27 goal
  const g = h.s().createGoal({ title: 'HandGoal', manualProgress: 20, manualMode: true });
  const goal = () => h.s().state.goals.find((x) => x.id === g.id);
  await until(() => row('goals', g.id)?.manual_mode === true, 'T27: goal row has manual_mode = true', 5000);
  const gp = h.s().createProject({ title: 'GoalProject', goalId: g.id });
  await until(() => row('projects', gp.id), 'T27: project reached projects', 5000);
  h.s().createTask({ title: 'GoalTask', projectId: gp.id });
  const gt = () => h.s().state.tasks.find((t) => t.title === 'GoalTask');
  await until(() => gt() && row('tasks', gt()!.id), 'T27: task reached tasks', 5000);
  h.s().toggleTaskCompleted(gt()!.id);
  await until(() => h.s().state.projects.find((x) => x.id === gp.id)?.status === 'completed', 'T27: auto project completes from its task');
  await quiet(1500);
  assert(goal()?.status === 'active' && goal()?.manualProgress === 20, 'T27: manual goal stays active at its hand % (state)');
  assert(row('goals', g.id)?.status === 'active', 'T27: manual goal stays active (row)');

  oldClientWrite('goals', g.id, 'HandGoal renamed');
  await until(() => goal()?.title === 'HandGoal renamed', 'T27: old-client rename reached the state');
  assert(row('goals', g.id)?.manual_mode === true && goal()?.manualMode === true, 'T27: old-client write keeps manual_mode = true');

  h.s().updateGoal(g.id, { manualMode: false, status: 'achieved' });
  await until(() => goal()?.status === 'achieved', 'T27: switch off → achieved (state)');
  await until(() => row('goals', g.id)?.status === 'achieved' && row('goals', g.id)?.manual_mode === false, 'T27: achieved, manual_mode false (row)', 5000);
  pass('T27 goal by hand: project completion moves nothing, old-client write keeps the flag, switch off achieves');

  // T28: saves built like ProjectsGoalsView.saveProject / saveGoal (no mode change in either).
  const writesOf = (table: string, id: string) =>
    fake.requests({ table }).filter((r) => r.method !== 'GET' && JSON.stringify(r.body ?? '').includes(id));
  const ap = h.s().createProject({ title: 'AutoProject' });
  h.s().createTask({ title: 'AutoOpen', projectId: ap.id });
  h.s().createTask({ title: 'AutoDone', projectId: ap.id });
  const autoDone = () => h.s().state.tasks.find((t) => t.title === 'AutoDone');
  await until(() => autoDone() && row('tasks', autoDone()!.id), 'T28: tasks reached tasks', 5000);
  h.s().toggleTaskCompleted(autoDone()!.id);
  await until(() => row('tasks', autoDone()!.id)?.completed === true, 'T28: one of two tasks done (row)', 5000);
  await quiet(1500);
  const apNow = h.s().state.projects.find((x) => x.id === ap.id)!;
  const pPayload = { title: 'AutoProject renamed', status: 'completed' as const, manualMode: false };
  const pMode = projectModePatch(apNow, false, 50);
  fake.resetCounts();
  h.s().updateProject(ap.id, { ...pPayload, ...pMode, ...projectStatusPatch({ ...apNow, ...pMode }, 'completed', true), ...projectSaveOutcomeFields(50, false, 'completed') });
  await until(() => row('projects', ap.id)?.status === 'in_progress', 'T28: project saved In progress (row)', 5000);
  await quiet(1500);
  const pWrites = writesOf('projects', ap.id);
  assert(pWrites.length === 1, `T28: one write of the project row (got ${pWrites.length})`);
  assert(!JSON.stringify(pWrites).includes('"completed"'), 'T28: Completed never uploaded');
  assert(h.s().state.projects.find((x) => x.id === ap.id)?.status === 'in_progress', 'T28: project In progress (state)');

  const ag = h.s().createGoal({ title: 'AutoGoal' });
  h.s().updateProject(ap.id, { goalId: ag.id });
  await until(() => row('projects', ap.id)?.goal_id === ag.id, 'T28: project linked to the goal (row)', 5000);
  await quiet(1500);
  const agNow = h.s().state.goals.find((x) => x.id === ag.id)!;
  const gMode = goalModePatch(agNow, false, 50);
  fake.resetCounts();
  h.s().updateGoal(ag.id, { title: 'AutoGoal renamed', status: 'achieved', manualMode: false, ...gMode, ...goalStatusPatch({ ...agNow, ...gMode }, 'achieved', true), ...goalSaveOutcomeFields(50, false, 'achieved') });
  await until(() => row('goals', ag.id)?.title === 'AutoGoal renamed', 'T28: goal edit reached goals', 5000);
  await quiet(1500);
  const gWrites = writesOf('goals', ag.id);
  assert(row('goals', ag.id)?.status === 'active' && h.s().state.goals.find((x) => x.id === ag.id)?.status === 'active', 'T28: goal stays Active (row + state)');
  assert(gWrites.length === 1 && !JSON.stringify(gWrites).includes('"achieved"'), `T28: one write of the goal row, Achieved never uploaded (got ${gWrites.length})`);
  pass('T28 automatic project/goal saved Completed/Achieved with open parts: one write, In progress / Active');
});
