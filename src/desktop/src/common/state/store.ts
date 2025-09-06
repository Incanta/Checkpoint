import { createStore, WritableAtom } from "jotai";

export const store = createStore();

interface AtomState {
  atom: WritableAtom<any, any, any>;
  shouldSync: boolean;
}

const AtomLookup: Map<string, AtomState> = new Map();

// More reliable way to detect main process in modern Electron
const isMain =
  typeof window === "undefined" &&
  typeof process !== "undefined" &&
  process.versions?.electron;
console.log("isMain:", isMain);

if (isMain) {
  // Dynamic import to avoid bundling issues
  import("electron")
    .then(({ ipcMain }) => {
      ipcMain.handle(`atom:value`, (event, key, value) => {
        const atom = AtomLookup.get(key);
        if (atom) {
          atom.shouldSync = false;
          store.set(atom.atom, value);
        }
      });
    })
    .catch(console.error);
} else if (typeof window !== "undefined" && window.electron) {
  window.electron.ipcRenderer.on(`atom:value`, (key, value) => {
    const atom = AtomLookup.get(key as string);
    if (atom) {
      atom.shouldSync = false;
      store.set(atom.atom, value);
    }
  });
}

export function syncAtom(atom: WritableAtom<any, any, any>, key: string): void {
  AtomLookup.set(key, { atom, shouldSync: true });

  store.sub(atom, () => {
    const atomState = AtomLookup.get(key);

    if (atomState === undefined || atomState.shouldSync === false) {
      if (atomState) atomState.shouldSync = true;
      return;
    }

    const value = store.get(atom);
    if (isMain) {
      // Dynamic import to avoid bundling issues in renderer
      import("electron")
        .then(({ BrowserWindow }) => {
          const windows = BrowserWindow.getAllWindows();
          windows.forEach((window: any) => {
            window.webContents.send("atom:value", key, value);
          });
        })
        .catch(console.error);
    } else if (typeof window !== "undefined" && window.electron) {
      window.electron.ipcRenderer.sendMessage("atom:value", key, value);
    }
  });
}
