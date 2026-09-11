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
import {
  applyLineChanges,
  intersectDiffWithRange,
  invertLineChange,
  toLineRanges,
  type DiffEditorSelectionHunkToolbarContext,
  type LineChange,
} from "./staging";

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

  // ── Line-range staging ────────────────────────────────────────────
  //
  // Mirrors the built-in git extension's Stage Change / Stage Selected Ranges
  // flows. All of them end the same way: produce the baseline content with
  // some changes applied, and hand that string to the daemon. Checkpoint's
  // staged-blob store keeps content, not hunk selections, so nothing here has
  // to be persisted as a selection.

  /**
   * Opens both sides of a file's diff: the workspace baseline (a checkpoint:
   * document) and the working-tree file.
   */
  async function openDiffSides(
    repository: CheckpointRepository,
    relPath: string,
  ): Promise<
    { original: vscode.TextDocument; modified: vscode.TextDocument } | undefined
  > {
    try {
      const original = await vscode.workspace.openTextDocument(
        headUri(repository.root, relPath),
      );
      const modified = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(repository.root, relPath)),
      );
      return { original, modified };
    } catch {
      return undefined;
    }
  }

  /** Applies `changes` to the baseline and stages the result. */
  async function stageLineChanges(
    repository: CheckpointRepository,
    relPath: string,
    changes: LineChange[],
  ): Promise<void> {
    const sides = await openDiffSides(repository, relPath);
    if (!sides) {
      return;
    }
    await repository.stageContent(
      relPath,
      applyLineChanges(sides.original, sides.modified, changes),
      resolveBucketFor(repository, relPath),
    );
  }

  /**
   * Which bucket a file's staged content belongs to.
   *
   * A file already staged somewhere keeps that destination, so staging a
   * second block does not silently move the first one. Otherwise the default
   * applies, which is the workspace's domain root.
   */
  function resolveBucketFor(
    repository: CheckpointRepository,
    relPath: string,
  ): string | undefined {
    return repository.claimBranchFor(relPath);
  }

  /**
   * Reverts `changes` by writing the baseline back over them in the working
   * tree. Unlike staging, this does change the file on disk.
   */
  async function revertLineChanges(
    repository: CheckpointRepository,
    relPath: string,
    changes: LineChange[],
  ): Promise<void> {
    const sides = await openDiffSides(repository, relPath);
    if (!sides) {
      return;
    }
    const inverted = changes.map(invertLineChange);
    const result = applyLineChanges(sides.modified, sides.original, inverted);
    await repository.writeWorkingTree(sides.modified, result);
  }

  /** The line changes for a file, computed by the daemon. */
  async function lineChangesFor(
    repository: CheckpointRepository,
    relPath: string,
  ): Promise<LineChange[] | undefined> {
    const result = await repository.getLineChanges(relPath);
    if (!result || result.isBinary) {
      return undefined;
    }
    return result.changes;
  }

  /**
   * Stage Change: the inline change widget VS Code renders from our
   * quickDiffProvider. It hands us the full change list plus which one was
   * clicked, so there is nothing to compute.
   */
  register("checkpoint.stageChange", async (...args) => {
    const uri = args[0];
    const changes = args[1] as LineChange[] | undefined;
    const index = args[2] as number | undefined;
    if (
      !(uri instanceof vscode.Uri) ||
      !changes ||
      index === undefined ||
      !changes[index]
    ) {
      return;
    }

    const repository = await resolveRepository(uri);
    if (!repository) {
      return;
    }

    await stageLineChanges(
      repository,
      relativeWorkspacePath(repository.root, uri.fsPath),
      [changes[index]!],
    );
  });

  /** Revert Change: the same widget's discard action. */
  register("checkpoint.revertChange", async (...args) => {
    const uri = args[0];
    const changes = args[1] as LineChange[] | undefined;
    const index = args[2] as number | undefined;
    if (
      !(uri instanceof vscode.Uri) ||
      !changes ||
      index === undefined ||
      !changes[index]
    ) {
      return;
    }

    const repository = await resolveRepository(uri);
    if (!repository) {
      return;
    }

    await revertLineChanges(
      repository,
      relativeWorkspacePath(repository.root, uri.fsPath),
      [changes[index]!],
    );
  });

  /** Stage Selected Ranges: every change the selection touches. */
  register("checkpoint.stageSelectedRanges", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const repository = await resolveRepository(editor.document.uri);
    if (!repository || !repository.containsUri(editor.document.uri)) {
      return;
    }

    const relPath = relativeWorkspacePath(
      repository.root,
      editor.document.uri.fsPath,
    );
    const changes = await lineChangesFor(repository, relPath);
    if (!changes) {
      return;
    }

    const selectedLines = toLineRanges(editor.selections, editor.document);
    const selected = changes
      .map((change) =>
        selectedLines.reduce<LineChange | null>(
          (result, range) =>
            result ?? intersectDiffWithRange(editor.document, change, range),
          null,
        ),
      )
      .filter((c): c is LineChange => c !== null);

    if (selected.length === 0) {
      void vscode.window.showInformationMessage(
        "Checkpoint: the selection does not contain any changes.",
      );
      return;
    }

    await stageLineChanges(repository, relPath, selected);
  });

  /** Revert Selected Ranges: discards those changes in the working tree. */
  register("checkpoint.revertSelectedRanges", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const repository = await resolveRepository(editor.document.uri);
    if (!repository || !repository.containsUri(editor.document.uri)) {
      return;
    }

    const relPath = relativeWorkspacePath(
      repository.root,
      editor.document.uri.fsPath,
    );
    const changes = await lineChangesFor(repository, relPath);
    if (!changes) {
      return;
    }

    const selectedLines = toLineRanges(editor.selections, editor.document);
    const selected = changes
      .map((change) =>
        selectedLines.reduce<LineChange | null>(
          (result, range) =>
            result ?? intersectDiffWithRange(editor.document, change, range),
          null,
        ),
      )
      .filter((c): c is LineChange => c !== null);

    if (selected.length === 0) {
      void vscode.window.showInformationMessage(
        "Checkpoint: the selection does not contain any changes.",
      );
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Discard ${selected.length} change(s) in ${relPath}?`,
      { modal: true },
      "Discard",
    );
    if (confirmed !== "Discard") {
      return;
    }

    await revertLineChanges(repository, relPath, selected);
  });

  /**
   * Stage Block / Stage Selection, from the diff editor's gutter toolbar.
   *
   * VS Code hands over `originalWithModifiedChanges`: the baseline with that
   * block already applied. That is precisely what the staged-blob store wants,
   * so this path does no diff arithmetic at all.
   *
   * NOTE: the gutter menus these are wired to (`diffEditor/gutter/hunk` and
   * `diffEditor/gutter/selection`) are a PROPOSED VS Code API
   * (`contribDiffEditorGutterToolBarMenus`), as is `TextEditor.diffInformation`.
   * The built-in git extension can use them because it ships inside VS Code.
   * These commands therefore only surface when the extension runs with
   * proposed APIs enabled; the Stage Change and Stage Selected Ranges flows
   * above are on stable API and work everywhere.
   */
  async function stageFromDiffToolbar(arg: unknown): Promise<void> {
    const context = arg as DiffEditorSelectionHunkToolbarContext | undefined;
    if (!context?.modifiedUri || context.modifiedUri.scheme !== "file") {
      return;
    }

    const repository = await resolveRepository(context.modifiedUri);
    if (!repository || !repository.containsUri(context.modifiedUri)) {
      return;
    }

    const relPath = relativeWorkspacePath(
      repository.root,
      context.modifiedUri.fsPath,
    );
    await repository.stageContent(
      relPath,
      context.originalWithModifiedChanges,
      resolveBucketFor(repository, relPath),
    );
  }

  register("checkpoint.diff.stageHunk", async (...args) => {
    await stageFromDiffToolbar(args[0]);
  });

  register("checkpoint.diff.stageSelection", async (...args) => {
    await stageFromDiffToolbar(args[0]);
  });

  register("checkpoint.stage", async (...args) => {
    const repository = await resolveRepository(args[0]);
    if (!repository) {
      return;
    }
    await repository.stage(resolveRelPaths(repository, args));
  });

  register("checkpoint.unstage", async (...args) => {
    const repository = await resolveRepository(args[0]);
    if (!repository) {
      return;
    }
    await repository.unstage(resolveRelPaths(repository, args));
  });

  register("checkpoint.moveToBranch", async (...args) => {
    const repository = await resolveRepository(args[0]);
    if (!repository) {
      return;
    }
    await repository.moveToBranch(resolveRelPaths(repository, args));
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
