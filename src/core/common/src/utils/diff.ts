export interface StateDiff {
  timestamp: Date;
  deletions: string[];
  changeListsToPull: number[];
}

export function DiffState(
  state: Record<string, number>,
  newState: Record<string, number>
): StateDiff {
  const deletions: string[] = [];
  const changeListsToPull: number[] = [];

  for (const stateFileId in state) {
    if (newState[stateFileId] === undefined) {
      deletions.push(stateFileId);
    } else if (state[stateFileId] !== newState[stateFileId]) {
      if (!changeListsToPull.includes(newState[stateFileId])) {
        changeListsToPull.push(newState[stateFileId]);
      }
    }
  }

  for (const newStateFileId in newState) {
    if (state[newStateFileId] === undefined) {
      if (!changeListsToPull.includes(newState[newStateFileId])) {
        changeListsToPull.push(newState[newStateFileId]);
      }
    }
  }

  return { timestamp: new Date(), deletions, changeListsToPull };
}
