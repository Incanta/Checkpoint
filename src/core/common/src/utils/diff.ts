export interface StateDiff {
  timestamp: Date;
  deletions: string[];
  changelistsToPull: number[];
}

export function DiffState(
  state: Record<string, number>,
  newState: Record<string, number>
): StateDiff {
  const deletions: string[] = [];
  const changelistsToPull: number[] = [];

  for (const stateFileId in state) {
    if (newState[stateFileId] === undefined) {
      deletions.push(stateFileId);
    } else if (state[stateFileId] !== newState[stateFileId]) {
      if (!changelistsToPull.includes(newState[stateFileId])) {
        changelistsToPull.push(newState[stateFileId]);
      }
    }
  }

  for (const newStateFileId in newState) {
    if (state[newStateFileId] === undefined) {
      if (!changelistsToPull.includes(newState[newStateFileId])) {
        changelistsToPull.push(newState[newStateFileId]);
      }
    }
  }

  return { timestamp: new Date(), deletions, changelistsToPull };
}
