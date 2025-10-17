import { createStore, WritableAtom } from "jotai";
import { ipcSend } from "../../main/channels";

export const store = createStore();

interface AtomState {
  atom: WritableAtom<any, any, any>;
  shouldSync: boolean;
}

const AtomLookup: Map<string, AtomState> = new Map();
const pendingAtomValues: Map<string, unknown> = new Map();

// More reliable way to detect main process in modern Electron
const isMain =
  typeof window === "undefined" &&
  typeof process !== "undefined" &&
  process.versions?.electron;

const applyIncomingAtomValue = (key: string, value: unknown): void => {
  const atomState = AtomLookup.get(key);

  if (!atomState) {
    if (!isMain) {
      pendingAtomValues.set(key, value);
    }
    return;
  }

  atomState.shouldSync = false;
  store.set(atomState.atom, value);
};

if (isMain) {
  // Dynamic import to avoid bundling issues
  import("electron")
    .then(({ ipcMain }) => {
      ipcMain.on(`atom:value`, (_event, payload) => {
        if (!payload) return;
        const { key, value } = payload as { key: string; value: unknown };
        applyIncomingAtomValue(key, value);
      });

      ipcMain.on("state:get", (event) => {
        AtomLookup.forEach((atomState, key) => {
          const value = store.get(atomState.atom);
          ipcSend(event.sender, "atom:value", { key, value });
        });
      });
    })
    .catch(console.error);
} else if (typeof window !== "undefined" && window.electron) {
  void import("./all")
    .then(() => {
      const queuedValues = Array.from(pendingAtomValues.entries());
      pendingAtomValues.clear();

      queuedValues.forEach(([key, value]) => {
        applyIncomingAtomValue(key, value);
      });

      window.electron?.ipcRenderer.sendMessage("state:get", null);
    })
    .catch(console.error);

  window.electron.ipcRenderer.on(`atom:value`, (data) => {
    applyIncomingAtomValue(data.key, data.value);
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
            ipcSend(window.webContents, "atom:value", { key, value });
          });
        })
        .catch(console.error);
    } else if (typeof window !== "undefined" && window.electron) {
      window.electron.ipcRenderer.sendMessage("atom:value", { key, value });
    }
  });

  if (!isMain) {
    const pendingValue = pendingAtomValues.get(key);
    if (pendingValue !== undefined) {
      pendingAtomValues.delete(key);
      applyIncomingAtomValue(key, pendingValue);
    }
  }
}
