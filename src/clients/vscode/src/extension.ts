import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { CheckpointContentProvider } from "./contentProvider";
import { CheckpointDecorationProvider } from "./decorationProvider";
import { CheckpointModel } from "./model";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Checkpoint");
  const model = new CheckpointModel(outputChannel);

  context.subscriptions.push(
    outputChannel,
    model,
    registerCommands(model),
    new CheckpointContentProvider(model),
    new CheckpointDecorationProvider(model),
  );

  await model.start();
}

export function deactivate(): void {
  // Disposal is handled through context.subscriptions.
}
