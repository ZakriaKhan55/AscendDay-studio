import { ArrowRight, Calendar, Target } from 'lucide-react';
import type { Project, ProjectStatus } from '@/types';
import { formatDateShort } from '@/lib/time/dates';
import { Chip, ItemCard, Nudge, StatusSelect } from './ItemCard';
import { PROJECT_STATUS_LABEL, type LockStatus, type ProjectProgress } from './hierarchy';

const STATUS_TONE = { not_started: 'neutral', in_progress: 'cyan', on_hold: 'warning', completed: 'success' } as const;

export function ProjectCard({
  project,
  prog,
  lock,
  goalName,
  today,
  onStatusChange,
  onOpenGoal,
  onOpenTasks,
  onAddTask,
  onUpdateProgress,
  onEdit,
  onDelete,
}: {
  project: Project;
  prog: ProjectProgress;
  lock: LockStatus;
  goalName: string | null;
  today: string;
  onStatusChange: (status: ProjectStatus) => void;
  onOpenGoal: () => void;
  onOpenTasks: () => void;
  onAddTask: () => void;
  onUpdateProgress: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const done = project.status === 'completed';
  const hasTasks = prog.linked > 0;
  // Set by hand (manualMode), or no tasks yet: the user updates it, so Update shows and Completed is allowed.
  const byHand = Boolean(project.manualMode);
  // Automatic and every task done: the project completes on its own, so only Completed holds.
  const allTasksDone = !prog.isManual && prog.percent === 100;
  const overdue = !done && Boolean(project.dueDate) && project.dueDate! < today;
  const dueToday = !done && project.dueDate === today;

  const detail = byHand
    ? hasTasks
      ? `You set this by hand · ${prog.linked} ${prog.linked === 1 ? 'task' : 'tasks'} linked`
      : 'You set this by hand'
    : hasTasks
      ? `${prog.completed} of ${prog.total} ${prog.total === 1 ? 'task' : 'tasks'} done`
      : 'No tasks yet, so you update it yourself';

  return (
    <ItemCard
      kindLabel="project"
      title={project.title}
      description={project.description}
      muted={lock.isLocked}
      onEdit={onEdit}
      onDelete={onDelete}
      lockedText={lock.isLocked && lock.blockingProject ? `Unlocks when "${lock.blockingProject.title}" is done.` : undefined}
      chips={
        <>
          <Chip tone={lock.isLocked ? 'neutral' : STATUS_TONE[project.status]}>
            {lock.isLocked ? 'Locked' : PROJECT_STATUS_LABEL[project.status]}
          </Chip>
          {lock.isSequentialGoal && (
            <Chip>
              Step {lock.stepIndex} of {lock.totalSteps}
            </Chip>
          )}
          {goalName ? (
            <Chip tone="purple" icon={<Target size={10} className="shrink-0" />} onClick={onOpenGoal} title={`Show the projects of "${goalName}"`}>
              {goalName}
            </Chip>
          ) : (
            <Chip>No goal</Chip>
          )}
          {project.dueDate && (
            <Chip tone={overdue ? 'danger' : dueToday ? 'warning' : 'neutral'} icon={<Calendar size={10} className="shrink-0" />}>
              {overdue ? 'Overdue' : dueToday ? 'Due today' : 'Due'} {formatDateShort(project.dueDate)}
            </Chip>
          )}
        </>
      }
      nudge={
        !hasTasks && !byHand && !done && !lock.isLocked ? (
          <Nudge
            tone="cyan"
            text="This project has no tasks yet. Add one small step to get started."
            actionLabel="+ Add task"
            onAction={onAddTask}
          />
        ) : undefined
      }
      progress={{
        percent: prog.percent,
        detail,
        tone: 'cyan',
        onUpdate: prog.isManual ? onUpdateProgress : undefined,
        updateDisabled: lock.isLocked,
      }}
      footer={
        <>
          <StatusSelect
            label={`Status of "${project.title}"`}
            value={project.status}
            disabled={lock.isLocked}
            onChange={(v) => onStatusChange(v as ProjectStatus)}
          >
            {/* With tasks, a project completes when they are all done and reopens when one is open
                (unless set by hand): a status the store would change straight back is not offered. */}
            <option value="not_started" disabled={allTasksDone}>
              {allTasksDone ? 'Not started (reopen a task first)' : 'Not started'}
            </option>
            <option value="in_progress" disabled={allTasksDone}>
              {allTasksDone ? 'In progress (reopen a task first)' : 'In progress'}
            </option>
            <option value="on_hold" disabled={allTasksDone}>
              {allTasksDone ? 'On hold (reopen a task first)' : 'On hold'}
            </option>
            <option value="completed" disabled={!prog.isManual && !done}>
              {!prog.isManual && !done ? 'Completed (when tasks are done)' : 'Completed'}
            </option>
          </StatusSelect>
          <button type="button" onClick={onOpenTasks} className="btn-secondary ml-auto px-3 py-1.5 text-xs text-cyan-hierarchy">
            <span>{hasTasks ? `${prog.linked} ${prog.linked === 1 ? 'task' : 'tasks'}` : 'Tasks'}</span>
            <ArrowRight size={13} aria-hidden="true" />
          </button>
        </>
      }
    />
  );
}
