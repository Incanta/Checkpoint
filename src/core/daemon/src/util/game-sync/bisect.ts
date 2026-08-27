import {
  getWorkspaceState,
  saveWorkspaceState,
  WORKSPACE_STATE_VERSION,
  type BisectVerdict,
  type Workspace,
} from "../util.js";
import { DaemonConfig } from "../../daemon-config.js";

/**
 * Record a bisect verdict for a single changelist and persist it into the
 * workspace state under gameSync.bisect. Other state fields are preserved and
 * the state version is bumped to the current WORKSPACE_STATE_VERSION.
 */
export async function setBisectVerdict(
  workspace: Workspace,
  changelistNumber: number,
  verdict: BisectVerdict,
): Promise<void> {
  const backend = (await DaemonConfig.Get()).stateBackend;
  const state = await getWorkspaceState(workspace.localPath, backend);

  const gameSync = state.gameSync ?? {};
  const bisect = gameSync.bisect ?? {};
  bisect[changelistNumber] = verdict;
  gameSync.bisect = bisect;
  state.gameSync = gameSync;
  state.version = WORKSPACE_STATE_VERSION;

  await saveWorkspaceState(workspace, state, backend);
}

/**
 * Clear all recorded bisect verdicts for the workspace. Leaves other gameSync
 * state intact.
 */
export async function resetBisect(workspace: Workspace): Promise<void> {
  const backend = (await DaemonConfig.Get()).stateBackend;
  const state = await getWorkspaceState(workspace.localPath, backend);

  if (state.gameSync?.bisect) {
    delete state.gameSync.bisect;
    state.version = WORKSPACE_STATE_VERSION;
    await saveWorkspaceState(workspace, state, backend);
  }
}

/**
 * Return the recorded bisect verdicts (changelist number -> verdict), or an
 * empty object when none have been recorded.
 */
export async function getBisectState(
  workspace: Workspace,
): Promise<Record<number, BisectVerdict>> {
  const backend = (await DaemonConfig.Get()).stateBackend;
  const state = await getWorkspaceState(workspace.localPath, backend);
  return state.gameSync?.bisect ?? {};
}

/** Result of computing the next changelist to test in a bisect session. */
export interface BisectNext {
  /** The changelist to sync to and test next, or null when none remain. */
  nextCl: number | null;
  /** Count of untested candidate changelists still in the open range. */
  remaining: number;
  /** The largest known-good ("pass") changelist bounding the range, or null. */
  low: number | null;
  /** The smallest known-bad ("fail") changelist bounding the range, or null. */
  high: number | null;
}

/**
 * Standard binary search over a branch history to isolate the changelist that
 * introduced a regression. Pure function; performs no IO.
 *
 * @param bisect changelist number -> verdict. "pass"/"fail" bound the search;
 *   "exclude" removes a changelist from consideration (e.g. unbuildable);
 *   "include" is treated as a still-untested candidate.
 * @param historyNumbers descending list of changelist numbers on the branch
 *   (newest first). Only changelists present in this list are considered.
 *
 * @returns bounds, the middle untested changelist to test next (by position in
 *   historyNumbers), and the remaining untested count. All fields are null/0
 *   when there is not yet both a "fail" and a "pass" to bound the range.
 */
export function computeBisectNext(
  bisect: Record<number, BisectVerdict>,
  historyNumbers: number[],
): BisectNext {
  const empty: BisectNext = {
    nextCl: null,
    remaining: 0,
    low: null,
    high: null,
  };

  // high = smallest "fail" CL that appears in the history.
  let high: number | null = null;
  for (const cl of historyNumbers) {
    if (bisect[cl] === "fail") {
      if (high === null || cl < high) {
        high = cl;
      }
    }
  }
  if (high === null) {
    return empty;
  }

  // low = largest "pass" CL strictly below high that appears in the history.
  let low: number | null = null;
  for (const cl of historyNumbers) {
    if (bisect[cl] === "pass" && cl < high) {
      if (low === null || cl > low) {
        low = cl;
      }
    }
  }
  if (low === null) {
    return { nextCl: null, remaining: 0, low: null, high };
  }

  // Candidate changelists are those strictly inside (low, high), in history
  // order, that are neither excluded nor already verdicted.
  const candidates: number[] = [];
  for (const cl of historyNumbers) {
    if (cl <= low || cl >= high) {
      continue;
    }
    const verdict = bisect[cl];
    if (verdict === "exclude" || verdict === "pass" || verdict === "fail") {
      continue;
    }
    candidates.push(cl);
  }

  if (candidates.length === 0) {
    return { nextCl: null, remaining: 0, low, high };
  }

  const mid = candidates[Math.floor(candidates.length / 2)] ?? null;
  return {
    nextCl: mid,
    remaining: candidates.length,
    low,
    high,
  };
}
