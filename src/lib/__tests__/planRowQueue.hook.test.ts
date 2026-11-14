// Hook test (real useAppState + in-process fake Supabase, see harness/): plan writes that must wait
// for a save still running for the same row (CodeRabbit 2026-11-14).
//   T32  CR-04-13: making a shared plan private while an older save (carrying "shared") is still
//        running: the change is queued behind that save, so the row ends private. Before, the
//        update went straight to the table and the late save made the plan public again while the
//        switch showed "Only me". A save started while the change is on its way is followed by a
//        corrective save.
//   T33  CR-04-15: removing a copied plan while a save of the copy is still running: the delete
//        is queued behind that save, so the row stays gone. Before, the late save recreated it.
import { bootHook, story, until, quiet, eq, assert, pass, server, fake } from './harness/bootHook';
import { UID } from './harness/fakeSupabase';

const blobAt = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';
const OTHER = '33333333-3333-4333-8333-333333333333';
const PUBLIC_PLAN = '77777777-7777-4777-8777-777777777777';

type PlanRow = { id: string; is_public?: boolean };
type FollowRow = { id: string };
type StepBody = { steps?: { items?: { id: string; completed: boolean }[] } };

await story('planRowQueue.hook (plan writes wait for running saves)', async () => {
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await quiet(1500);
  const planRow = (id: string) => (server.g('improvement_plans') as PlanRow[]).find((r) => r.id === id);
  const followRows = () => server.g('user_plan_follows') as FollowRow[];
  const plan = (title: string) => h.s().state.improvementPlans.find((p) => p.title === title);

  // T32: a shared plan with two steps, saved.
  h.s().createImprovementPlan('QueuePlan', '', true, ['Step A', 'Step B']);
  await until(() => plan('QueuePlan') && planRow(plan('QueuePlan')!.id)?.is_public === true, 'T32: shared plan reached the table', 5000);
  await until(() => plan('QueuePlan')!.syncStatus === 'synced', 'T32: plan marked synced');
  const planId = plan('QueuePlan')!.id;
  const [stepA, stepB] = plan('QueuePlan')!.steps.map((s) => s.id);
  // Save 1 (step A) goes through; save 2 (step B, still "shared") is held in flight.
  const late = fake.hold(
    (r) => r.method === 'POST' && r.table === 'improvement_plans' && Boolean((r.body as StepBody)?.steps?.items?.find((s) => s.id === stepB)?.completed)
  );
  h.s().completePlanStep(planId, stepA);
  h.s().completePlanStep(planId, stepB);
  await until(() => late.hits === 1, 'T32: the second save is in flight');
  await until(() => plan('QueuePlan')!.syncStatus === 'synced', 'T32: the first save marked the plan synced');
  const toggled = h.s().togglePlanVisibility(planId, false);
  await quiet(400);
  late.release();
  await toggled;
  await until(() => plan('QueuePlan')!.isPublic === false, 'T32: plan private in state');
  await quiet(1500);
  eq(planRow(planId)?.is_public, false, 'T32: the row ends private (the older save did not undo it)');
  // A save started while the sharing change is on its way still carries the old setting: a
  // corrective save goes after it.
  await h.s().togglePlanVisibility(planId, true);
  await until(() => planRow(planId)?.is_public === true && plan('QueuePlan')!.isPublic === true, 'T32: shared again');
  await until(() => plan('QueuePlan')!.syncStatus !== 'pending', 'T32: nothing saving');
  const patch = fake.hold((r) => r.method === 'PATCH' && r.table === 'improvement_plans');
  const toggledAgain = h.s().togglePlanVisibility(planId, false);
  await until(() => patch.hits === 1, 'T32: the sharing change is in flight');
  h.s().completePlanStep(planId, stepA);
  await quiet(300);
  patch.release();
  await toggledAgain;
  await quiet(1500);
  eq([plan('QueuePlan')!.isPublic, planRow(planId)?.is_public], [false, false], 'T32: a save started meanwhile does not leave the row shared');
  pass('T32 a sharing change waits for a running save of the plan, and a save started meanwhile is corrected; the row ends private');

  // T33: a copied plan whose save is still running is removed.
  const original = {
    ...plan('QueuePlan')!, id: PUBLIC_PLAN, creatorId: OTHER, creatorUsername: 'other', title: 'TheirQueuePlan', isPublic: true, copyCount: 0, syncStatus: undefined,
  };
  eq(await h.s().copyPublicPlan(original), true, 'T33: copy added');
  const follow = () => h.s().state.followedPlans.find((f) => f.originalPlanId === PUBLIC_PLAN);
  await until(() => follow() && followRows().some((r) => r.id === follow()!.id), 'T33: copy reached user_plan_follows', 5000);
  await until(() => follow()!.syncStatus === 'synced', 'T33: copy marked synced');
  const followId = follow()!.id;
  const copySave = fake.hold((r) => r.method === 'POST' && r.table === 'user_plan_follows');
  h.s().completeFollowedPlanStep(followId, follow()!.steps[0].id);
  await until(() => copySave.hits === 1, 'T33: the copy save is in flight');
  const removed = h.s().deleteFollowedPlan(followId);
  await quiet(400);
  copySave.release();
  await removed;
  await until(() => !h.s().state.followedPlans.some((f) => f.id === followId), 'T33: copy removed from state');
  await quiet(1500);
  assert(!followRows().some((r) => r.id === followId), 'T33: the copy row stays removed (the late save did not bring it back)');
  pass('T33 removing a copy waits for its running save; the row stays removed');
});
