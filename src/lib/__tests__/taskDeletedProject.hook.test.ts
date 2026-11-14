// Hook test (real useAppState + in-process fake Supabase, see harness/): a task is never linked to a
// project that is gone (CodeRabbit CR-04-3, 2026-11-14: the Tasks quick add kept a project chosen
// before it was deleted).
//   T42  a task for a live project keeps its project; a task created with the id of a project
//        deleted meanwhile is saved without a project (in state and in its tasks row).
import { bootHook, story, until, quiet, rows, eq, pass, server, UID } from './harness/bootHook';

const blobAt = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';

await story('taskDeletedProject.hook (task for a deleted project)', async () => {
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await until(() => h.s().isServerDataApplied, 'server data applied');
  await quiet(1500);

  const live = h.s().createProject({ title: 'HookLiveProject' });
  const gone = h.s().createProject({ title: 'HookGoneProject' });
  await until(() => h.s().state.projects.some((p) => p.id === gone.id), 'T42: projects in state');
  h.s().deleteProject(gone.id);
  await until(() => !h.s().state.projects.some((p) => p.id === gone.id), 'T42: project deleted');

  const kept = h.s().createTask({ title: 'HookTaskLive', projectId: live.id });
  eq(kept.projectId, live.id, 'T42: a task for a live project keeps it');
  const orphan = h.s().createTask({ title: 'HookTaskGone', projectId: gone.id });
  eq(orphan.projectId, undefined, 'T42: a task for a deleted project gets no project');
  const inState = () => h.s().state.tasks.find((t) => t.id === orphan.id);
  await until(inState, 'T42: task in state');
  eq(inState()!.projectId, undefined, 'T42: no project in state');
  await until(() => rows('tasks').some((r) => r.id === orphan.id), 'T42: task reached tasks', 5000);
  const row = rows('tasks').find((r) => r.id === orphan.id);
  eq(row?.data?.projectId ?? row?.project_id ?? undefined, undefined, 'T42: no project in its row');
  pass('T42 a task is never linked to a deleted project');
});
