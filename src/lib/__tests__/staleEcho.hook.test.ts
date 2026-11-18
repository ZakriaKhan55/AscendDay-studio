// Hook test (real useAppState + in-process fake Supabase, see harness/): a late realtime echo of an
// earlier save must not undo a newer one on the tables that opt in to dropsOlderEvents besides
// reading_books (bookLateEcho.hook): list_orders (two reorders in a row) and tasks (two subtask ticks
// in a row; the row's updatedAt is its updated_at column).
//   T33  the first reorder's echo, delivered after the second reorder was saved, leaves the second order;
//        a newer row from another device is still taken.
//   T34  the first tick's echo, delivered after the second tick was saved, leaves both ticks;
//        a newer row from another device is still taken.
import { bootHook, story, until, quiet, rows, eq, pass, server, UID } from './harness/bootHook';

const blobAt = '2026-11-01T00:00:00.000Z';
// eslint-disable-next-line no-restricted-syntax -- a stamp after every save of the test
const later = (iso: unknown) => new Date(Date.parse(String(iso)) + 60_000).toISOString();

await story('staleEcho.hook (late realtime echo on list_orders and tasks)', async () => {
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await quiet(1500);

  // ── T33 list_orders ──
  type OrderRow = { id: string; data?: { ids?: string[]; updatedAt?: string } };
  const orderRow = () => rows('list_orders').find((r: OrderRow) => r.id === 'habits') as OrderRow | undefined;
  const order = () => h.s().state.listOrders?.find((o) => o.id === 'habits')?.ids;
  h.s().saveListOrder('habits', ['a', 'b', 'c']);
  await until(() => orderRow()?.data?.ids?.join() === 'a,b,c', 'T33: first order saved', 5000);
  const firstOrder = structuredClone(orderRow()!);
  await quiet(50);
  h.s().saveListOrder('habits', ['c', 'b', 'a']);
  await until(() => orderRow()?.data?.ids?.join() === 'c,b,a', 'T33: second order saved', 5000);
  await quiet(800);
  server.emit('list_orders', structuredClone(firstOrder), 'UPDATE');
  await quiet(800);
  eq(order(), ['c', 'b', 'a'], 'T33: a late echo of the first reorder leaves the second order');

  const newerOrder = structuredClone(orderRow()!);
  newerOrder.data = { ...newerOrder.data, ids: ['b', 'a', 'c'], updatedAt: later(newerOrder.data!.updatedAt) };
  server.emit('list_orders', newerOrder, 'UPDATE');
  await until(() => order()?.join() === 'b,a,c', 'T33: a newer order from another device is taken');
  pass('T33 a late echo of an earlier reorder never undoes the next one; newer rows still apply');

  // ── T34 tasks ──
  type TaskRow = { id: string; title?: string; subtasks?: { id: string; completed: boolean }[]; updated_at?: string };
  h.s().createTask({
    title: 'EchoTask',
    subtasks: [
      { id: 's1', title: 'one', completed: false },
      { id: 's2', title: 'two', completed: false },
      { id: 's3', title: 'three', completed: false },
    ],
  });
  await until(() => h.s().state.tasks.find((t) => t.title === 'EchoTask'), 'T34: task in state');
  const id = h.s().state.tasks.find((t) => t.title === 'EchoTask')!.id;
  const taskRow = () => rows('tasks').find((r: TaskRow) => r.id === id) as TaskRow | undefined;
  const done = (row?: { subtasks?: { id: string; completed: boolean }[] }) =>
    (row?.subtasks || []).filter((s) => s.completed).map((s) => s.id).join();
  await until(() => taskRow(), 'T34: task row saved', 5000);
  await quiet(50);
  h.s().toggleSubtask(id, 's1');
  await until(() => done(taskRow()) === 's1', 'T34: first tick saved', 5000);
  const firstTick = structuredClone(taskRow()!);
  await quiet(50);
  h.s().toggleSubtask(id, 's2');
  await until(() => done(taskRow()) === 's1,s2', 'T34: second tick saved', 5000);
  await quiet(800);
  server.emit('tasks', structuredClone(firstTick), 'UPDATE');
  await quiet(800);
  eq(done(h.s().state.tasks.find((t) => t.id === id)), 's1,s2', 'T34: a late echo of the first tick leaves both ticks');

  const newerTask = structuredClone(taskRow()!);
  newerTask.title = 'EchoTaskRenamed';
  newerTask.updated_at = later(newerTask.updated_at);
  server.emit('tasks', newerTask, 'UPDATE');
  await until(() => h.s().state.tasks.some((t) => t.id === id && t.title === 'EchoTaskRenamed'), 'T34: a newer task row from another device is taken');
  pass('T34 a late echo of an earlier subtask tick never undoes the next one; newer rows still apply');
});
