import { randomUUID } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { FileStatus } from "@checkpointvcs/daemon";
import { emptyUri, headUri } from "./contentProvider";
import type { CheckpointModel } from "./model";
import {
  CheckpointRepository,
  CheckpointResource,
  errorMessage,
} from "./repository";
import { relativeWorkspacePath } from "./util";

function isSourceControl(arg: unknown): arg is vscode.SourceControl {
  return (
    typeof arg === "object" &&
    arg !== null &&
    "inputBox" in arg &&
    "createResourceGroup" in arg
  );
}

function isResourceGroup(
  arg: unknown,
): arg is vscode.SourceControlResourceGroup {
  return (
    typeof arg === "object" &&
    arg !== null &&
    "resourceStates" in arg &&
    "hideWhenEmpty" in arg
  );
}

export function registerCommands(model: CheckpointModel): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  /**
   * Resolves the target repository from whatever VS Code passed us: the
   * SourceControl (scm/title, input box), a resource group or resource
   * state (context menus), a file URI, the active editor, or a quick pick
   * as the last resort.
   */
  async function resolveRepository(
    arg?: unknown,
  ): Promise<CheckpointRepository | undefined> {
    if (arg instanceof CheckpointResource) {
      return arg.repository;
    }
    if (isSourceControl(arg)) {
      const repo = model.repositoryList.find((r) => r.sourceControl === arg);
      if (repo) {
        return repo;
      }
    }
    if (isResourceGroup(arg)) {
      const first = arg.resourceStates[0];
      if (first instanceof CheckpointResource) {
        return first.repository;
      }
    }
    if (arg instanceof vscode.Uri) {
      const repo = model.getRepository(arg);
      if (repo) {
        return repo;
      }
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const repo = model.getRepository(activeUri);
      if (repo) {
        return repo;
      }
    }

    return model.pickRepository();
  }

  /** Collects the resource states a resource/group context command targets. */
  function resolveResources(args: unknown[]): CheckpointResource[] {
    const resources: CheckpointResource[] = [];
    for (const arg of args) {
      if (arg instanceof CheckpointResource) {
        resources.push(arg);
      } else if (isResourceGroup(arg)) {
        for (const state of arg.resourceStates) {
          if (state instanceof CheckpointResource) {
            resources.push(state);
          }
        }
      }
    }
    return resources;
  }

  /**
   * Commands like checkout/file history can be invoked from the palette or
   * an editor; resolve a workspace-relative path for the target file.
   */
  function resolveRelPaths(
    repository: CheckpointRepository,
    args: unknown[],
  ): string[] {
    const resources = resolveResources(args);
    if (resources.length > 0) {
      return resources.map((r) => r.relPath);
    }
    for (const arg of args) {
      if (arg instanceof vscode.Uri && repository.containsUri(arg)) {
        return [relativeWorkspacePath(repository.root, arg.fsPath)];
      }
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri && repository.containsUri(activeUri)) {
      return [relativeWorkspacePath(repository.root, activeUri.fsPath)];
    }
    return [];
  }

  function register(
    command: string,
    callback: (...args: unknown[]) => unknown,
  ): void {
    disposables.push(vscode.commands.registerCommand(command, callback));
  }

  register("checkpoint.refresh", async (arg) => {
    const repository = await resolveRepository(arg);
    if (!repository) {
      return;
    }
    await repository.refresh();
    await repository.updateSyncStatus(true);
  });

  register("checkpoint.submit", async (arg, ...rest) => {
    const repository = await resolveRepository(arg);
    if (!repository) {
      return;
    }
    const resources = resolveResources([arg, ...rest]);
    await repository.submit(resources.length > 0 ? resources : undefined);
  });

  register("checkpoint.pull", async (arg) => {
    const repository = await resolveRepository(arg);
    if (!repository) {
      return;
    }
    await repository.pull();
  });

  register("checkpoint.openDiff", async (arg) => {
    let resource: CheckpointResource | undefined;

    if (arg instanceof CheckpointResource) {
      resource = arg;
    } else {
      const uri =
        arg instanceof vscode.Uri
          ? arg
          : vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        return;
      }
      const repository = model.getRepository(uri);
      if (!repository) {
        return;
      }
      const relPath = relativeWorkspacePath(repository.root, uri.fsPath);
      const file = repository.getPendingFile(relPath);
      if (!file) {
        void vscode.window.showInformationMessage(
          "Checkpoint: this file has no pending changes.",
        );
        return;
      }
      resource = new CheckpointResource(repository, relPath, file, "changes");
    }

    const { repository, relPath, file } = resource;
    const name = path.basename(relPath);

    switch (file.status) {
      case FileStatus.Deleted:
        await vscode.commands.executeCommand(
          "vscode.diff",
          headUri(repository.root, relPath),
          emptyUri(repository.root, relPath),
          `${name} (Deleted)`,
        );
        return;

      case FileStatus.Added:
      case FileStatus.Local:
      case FileStatus.NotChangedCheckedOut:
        await vscode.commands.executeCommand(
          "vscode.open",
          resource.resourceUri,
        );
        return;

      default:
        await vscode.commands.executeCommand(
          "vscode.diff",
          headUri(repository.root, relPath),
          resource.resourceUri,
          `${name} (Head ↔ Working)`,
        );
    }
  });

  register("checkpoint.openFile", async (...args) => {
    const resources = resolveResources(args);
    for (const resource of resources) {
      if (resource.file.status === FileStatus.Deleted) {
        continue;
      }
      await vscode.commands.executeCommand("vscode.open", resource.resourceUri);
    }
  });

  register("checkpoint.revert", async (...args) => {
    const resources = resolveResources(args);
    if (resources.length === 0) {
      return;
    }
    await resources[0].repository.revert(resources);
  });

  register("checkpoint.markForAdd", async (...args) => {
    const repository = await resolveRepository(args[0]);
    if (!repository) {
      return;
    }
    await repository.markForAdd(resolveRelPaths(repository, args));
  });

  register("checkpoint.unmarkForAdd", async (...args) => {
    const repository = await resolveRepository(args[0]);
    if (!repository) {
      return;
    }
    await repository.unmarkForAdd(resolveRelPaths(repository, args));
  });

  register("checkpoint.checkoutFile", async (...args) => {
    const repository = await resolveRepository(args[0]);
    if (!repository) {
      return;
    }
    await repository.checkout(resolveRelPaths(repository, args), false);
  });

  register("checkpoint.checkoutFileLocked", async (...args) => {
    const repository = await resolveRepository(args[0]);
    if (!repository) {
      return;
    }
    await repository.checkout(resolveRelPaths(repository, args), true);
  });

  register("checkpoint.undoCheckout", async (...args) => {
    const repository = await resolveRepository(args[0]);
    if (!repository) {
      return;
    }
    await repository.undoCheckout(resolveRelPaths(repository, args));
  });

  register("checkpoint.resolveConflicts", async (...args) => {
    const repository = await resolveRepository(args[0]);
    if (!repository) {
      return;
    }
    await repository.resolveConflicts(resolveRelPaths(repository, args));
  });

  register("checkpoint.switchBranch", async (arg) => {
    const repository = await resolveRepository(arg);
    if (!repository) {
      return;
    }
    await repository.switchBranch();
  });

  register("checkpoint.createBranch", async (arg) => {
    const repository = await resolveRepository(arg);
    if (!repository) {
      return;
    }
    await repository.createBranch();
  });

  register("checkpoint.showHistory", async (arg) => {
    const repository = await resolveRepository(arg);
    if (!repository) {
      return;
    }
    await repository.showHistory();
  });

  register("checkpoint.fileHistory", async (...args) => {
    const repository = await resolveRepository(args[0]);
    if (!repository) {
      return;
    }
    const relPaths = resolveRelPaths(repository, args);
    if (relPaths.length === 0) {
      void vscode.window.showInformationMessage(
        "Checkpoint: open a file in a Checkpoint workspace first.",
      );
      return;
    }
    await repository.fileHistory(relPaths[0]);
  });

  // ─── Auth ──────────────────────────────────────────────────────────

  register("checkpoint.login", async () => {
    const endpoint = await vscode.window.showInputBox({
      prompt: "Checkpoint server endpoint",
      value: "https://checkpointvcs.com",
      ignoreFocusOut: true,
    });
    if (!endpoint) {
      return;
    }

    const daemonId = randomUUID();

    try {
      const client = await model.getClient();
      const { code, url } = await client.auth.login.mutate({
        endpoint,
        daemonId,
      });

      const open = await vscode.window.showInformationMessage(
        `Checkpoint: approve this device in your browser with code ${code}.`,
        "Open Browser",
      );
      if (open === "Open Browser") {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }

      const user = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Checkpoint: waiting for device approval (code ${code})`,
          cancellable: true,
        },
        async (_progress, token) => {
          // The daemon polls the server and saves the token once the user
          // approves; poll getUser until that has happened.
          const deadline = Date.now() + 5 * 60 * 1000;
          while (Date.now() < deadline && !token.isCancellationRequested) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const { user } = await client.auth.getUser.query({ daemonId });
              return user;
            } catch {
              // Not approved yet.
            }
          }
          return null;
        },
      );

      if (user) {
        void vscode.window.showInformationMessage(
          `Checkpoint: signed in as ${user.name ?? user.email}.`,
        );
        await model.scan();
        await model.ensureConnection();
      } else {
        void vscode.window.showWarningMessage(
          "Checkpoint: sign-in was not completed.",
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: sign-in failed. ${errorMessage(error)}`,
      );
    }
  });

  register("checkpoint.loginWithToken", async () => {
    const endpoint = await vscode.window.showInputBox({
      prompt: "Checkpoint server endpoint",
      value: "https://checkpointvcs.com",
      ignoreFocusOut: true,
    });
    if (!endpoint) {
      return;
    }

    const token = await vscode.window.showInputBox({
      prompt: "API token (create one in the web UI under Settings → Devices)",
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) {
      return;
    }

    try {
      const client = await model.getClient();
      const { user } = await client.auth.loginWithToken.mutate({
        endpoint,
        daemonId: randomUUID(),
        token,
      });
      void vscode.window.showInformationMessage(
        `Checkpoint: signed in as ${user.name ?? user.email}.`,
      );
      await model.scan();
      await model.ensureConnection();
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: sign-in failed. ${errorMessage(error)}`,
      );
    }
  });

  register("checkpoint.logout", async () => {
    try {
      const client = await model.getClient();
      const { users } = await client.auth.getUsers.query();
      if (users.length === 0) {
        void vscode.window.showInformationMessage(
          "Checkpoint: no signed-in users.",
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        users.map((user) => ({
          label: user.name ?? user.email,
          description: user.endpoint,
          user,
        })),
        { placeHolder: "Sign out of which account?" },
      );
      if (!picked) {
        return;
      }

      await client.auth.logout.mutate({ daemonId: picked.user.daemonId });
      void vscode.window.showInformationMessage(
        `Checkpoint: signed out ${picked.label}.`,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: sign-out failed. ${errorMessage(error)}`,
      );
    }
  });

  return vscode.Disposable.from(...disposables);
}
