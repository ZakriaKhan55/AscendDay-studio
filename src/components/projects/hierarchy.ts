import { useCallback, useMemo } from 'react';
import type { Goal, GoalStatus, Project, ProjectStatus, Task } from '@/types';
import {
  clampPercent,
  goalProgressOf,
  projectProgressOf,
  projectsByGoalId,
  tasksByProjectId,
  type GoalProgress,
  type ProjectProgress,
} from '@/lib/items/projectProgress';
import { sortBySequence } from '@/lib/items/listOrder';

export type { GoalProgress, ProjectProgress };

/**
 * Live progress for the Projects & Goals page (rules in lib/projectProgress.ts), plus the
 * sequential lock. The automatic status is applied by the store, not here.
 */

export interface LockStatus {
  isLocked: boolean;
  blockingProject?: Project;
  stepIndex?: number;
  totalSteps?: number;
  isSequentialGoal: boolean;
}

/** Where a manual item lands when its "done" status is taken back: just short of done. */
export const REOPENED_PERCENT = 95;

export { sortBySequence };

/**
 * The sequential lock: a project of an in-order goal is locked while a project before it is not
 * done. A done project is never locked, wherever it sits (it can sit after an unfinished one when
 * the order changes or an earlier project reopens).
 */
export function lockStatusOf(
  project: Project,
  goals: readonly Goal[],
  projectsByGoal: ReadonlyMap<string, Project[]>,
  isComplete: (p: Project) => boolean
): LockStatus {
  const goal = project.goalId ? goals.find((g) => g.id === project.goalId) : undefined;
  if (!goal?.sequentialMode) return { isLocked: false, isSequentialGoal: false };
  const linked = sortBySequence(projectsByGoal.get(goal.id) ?? []);
  const index = linked.findIndex((p) => p.id === project.id);
  const blockingProject = isComplete(project) ? undefined : linked.slice(0, Math.max(index, 0)).find((p) => !isComplete(p));
  return {
    isLocked: Boolean(blockingProject),
    blockingProject,
    stepIndex: index + 1,
    totalSteps: linked.length,
    isSequentialGoal: true,
  };
}

export function useHierarchy(goals: Goal[], projects: Project[], tasks: Task[]) {
  const tasksByProject = useMemo(() => tasksByProjectId(tasks), [tasks]);
  const projectsByGoal = useMemo(() => projectsByGoalId(projects), [projects]);

  const getProjectProgress = useCallback(
    (project: Project): ProjectProgress => projectProgressOf(project, tasksByProject.get(project.id) ?? []),
    [tasksByProject]
  );

  /** Done by status or by reaching 100%. A done project counts as 100% toward its goal. */
  const isProjectComplete = useCallback(
    (project: Project) => project.status === 'completed' || getProjectProgress(project).percent === 100,
    [getProjectProgress]
  );

  const getLockStatus = useCallback(
    (project: Project): LockStatus => lockStatusOf(project, goals, projectsByGoal, isProjectComplete),
    [goals, projectsByGoal, isProjectComplete]
  );

  const isLockedId = useCallback(
    (projectId?: string) => {
      if (!projectId) return false;
      const p = projects.find((x) => x.id === projectId);
      return p ? getLockStatus(p).isLocked : false;
    },
    [projects, getLockStatus]
  );

  const getGoalProgress = useCallback(
    (goal: Goal): GoalProgress => goalProgressOf(goal, projectsByGoal.get(goal.id) ?? [], getProjectProgress),
    [projectsByGoal, getProjectProgress]
  );

  /** The % a project would get from its tasks with "Set progress by hand" off; null with no tasks. */
  const getProjectAutoPercent = useCallback(
    (project: Project): number | null => {
      const prog = projectProgressOf({ ...project, manualMode: false }, tasksByProject.get(project.id) ?? []);
      return prog.isManual ? null : prog.percent;
    },
    [tasksByProject]
  );

  /** The % a goal would get from its projects with "Set progress by hand" off; null with no projects. */
  const getGoalAutoPercent = useCallback(
    (goal: Goal): number | null => {
      const prog = goalProgressOf({ ...goal, manualMode: false }, projectsByGoal.get(goal.id) ?? [], getProjectProgress);
      return prog.isManual ? null : prog.percent;
    },
    [projectsByGoal, getProjectProgress]
  );

  return useMemo(
    () => ({
      tasksByProject,
      projectsByGoal,
      getProjectProgress,
      isProjectComplete,
      getLockStatus,
      isLockedId,
      getGoalProgress,
      getProjectAutoPercent,
      getGoalAutoPercent,
    }),
    [tasksByProject, projectsByGoal, getProjectProgress, isProjectComplete, getLockStatus, isLockedId, getGoalProgress, getProjectAutoPercent, getGoalAutoPercent]
  );
}

/**
 * The fields to save when a goal's status changes. A goal with projects becomes Achieved on its
 * own, so only a goal without projects (updated by hand) moves its % with the status: Achieved
 * fills it to 100, and taking Achieved back drops it just short of done. A goal set by hand
 * (manualMode) is updated by hand too: callers pass hasProjects && !manualMode.
 */
export function goalStatusPatch(goal: Pick<Goal, 'status' | 'manualProgress'> | null, next: GoalStatus, hasProjects: boolean): Partial<Goal> {
  if (hasProjects) return { status: next };
  const current = clampPercent(goal?.manualProgress);
  if (next === 'achieved') return { status: next, manualProgress: 100 };
  if (goal?.status === 'achieved' && current >= 100) return { status: next, manualProgress: REOPENED_PERCENT };
  return { status: next };
}

/**
 * Same rule for a project: one with tasks completes on its own; one without moves its % with the
 * status. Callers pass hasTasks && !manualMode, so a project set by hand moves its % too.
 */
export function projectStatusPatch(project: Pick<Project, 'status' | 'manualProgress'> | null, next: ProjectStatus, hasTasks: boolean): Partial<Project> {
  if (hasTasks) return { status: next };
  const current = clampPercent(project?.manualProgress);
  if (next === 'completed') return { status: next, manualProgress: 100 }; // the store stamps completedAt
  if (project?.status === 'completed' && current >= 100) return { status: next, manualProgress: REOPENED_PERCENT };
  return { status: next };
}

/**
 * The fields to save when "Set progress by hand" changes on a project. Turning it on starts the
 * hand % at what the card shows right now (100 for a completed project), so the bar never jumps;
 * the status stays. Turning it off keeps the hand % in the row (used again only with 0 tasks).
 */
export function projectModePatch(
  project: Pick<Project, 'status' | 'manualMode'> | null,
  nextManual: boolean,
  shownPercent: number
): Partial<Project> {
  if (!project || Boolean(project.manualMode) === nextManual) return {};
  if (!nextManual) return { manualMode: false };
  return { manualMode: true, manualProgress: project.status === 'completed' ? 100 : clampPercent(shownPercent) };
}

/** Same for a goal: on starts at the shown % (100 when Achieved), off keeps the hand % in the row. */
export function goalModePatch(goal: Pick<Goal, 'status' | 'manualMode'> | null, nextManual: boolean, shownPercent: number): Partial<Goal> {
  if (!goal || Boolean(goal.manualMode) === nextManual) return {};
  if (!nextManual) return { manualMode: false };
  return { manualMode: true, manualProgress: goal.status === 'achieved' ? 100 : clampPercent(shownPercent) };
}

export type SwitchOffOutcome = 'complete' | 'reopen' | 'none';

/**
 * What the automatic status does once "Set progress by hand" is turned off on a project: its
 * progress comes from its tasks again (`fromTasks`, null with no tasks), so it completes when they
 * are all done and reopens when one is open.
 */
export function projectSwitchOffOutcome(fromTasks: number | null, status: ProjectStatus): SwitchOffOutcome {
  if (fromTasks === null) return 'none';
  if (fromTasks === 100 && status !== 'completed') return 'complete';
  if (fromTasks < 100 && status === 'completed') return 'reopen';
  return 'none';
}

/** Same for a goal (`fromProjects`, null with no projects). Abandoned goals never change on their own. */
export function goalSwitchOffOutcome(fromProjects: number | null, status: GoalStatus): SwitchOffOutcome {
  if (fromProjects === null || status === 'abandoned') return 'none';
  if (fromProjects === 100 && status === 'active') return 'complete';
  if (fromProjects < 100 && status === 'achieved') return 'reopen';
  return 'none';
}

/**
 * The status a saved edit of a project adds so it lands where its tasks put it, in the same write
 * as the edit: whenever the project ends up automatic (switched off now, or already automatic), a
 * Completed its open tasks don't allow is reopened and all-done tasks complete it. Set by hand:
 * nothing. Without this the store's auto-status effect would fix it in a second quick write.
 */
export function projectSaveOutcomeFields(fromTasks: number | null, nextManual: boolean, status: ProjectStatus): Partial<Project> {
  if (nextManual) return {};
  const outcome = projectSwitchOffOutcome(fromTasks, status);
  return outcome === 'complete' ? { status: 'completed' } : outcome === 'reopen' ? { status: 'in_progress' } : {};
}

/** Same for a goal and its projects (Achieved / Active; abandoned never changes on its own). */
export function goalSaveOutcomeFields(fromProjects: number | null, nextManual: boolean, status: GoalStatus): Partial<Goal> {
  if (nextManual) return {};
  const outcome = goalSwitchOffOutcome(fromProjects, status);
  return outcome === 'complete' ? { status: 'achieved' } : outcome === 'reopen' ? { status: 'active' } : {};
}

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  active: 'Active',
  achieved: 'Achieved',
  abandoned: 'Abandoned',
};

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  on_hold: 'On hold',
  completed: 'Completed',
};
