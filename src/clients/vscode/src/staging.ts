/*---------------------------------------------------------------------------------------------
 *  Portions adapted from the VS Code built-in Git extension
 *  (extensions/git/src/staging.ts).
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

/**
 * Line-range staging, the way VS Code's git extension does it.
 *
 * These algorithms are adapted rather than reinvented on purpose. They carry
 * several genuinely subtle end-of-document cases (a deletion of the final
 * line, an insertion past the last line) that are easy to get wrong and that
 * the upstream implementation has already had bug reports against. The shape
 * of the data is fixed by VS Code's `TextEditorDiffInformation` anyway, so
 * there is nothing to gain by diverging.
 *
 * The whole staging flow here produces a STRING: the original content with
 * the chosen changes applied. That is exactly what Checkpoint's staged-blob
 * store wants, and it is why hunk selections never need to be persisted.
 */

export interface LineChange {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

/** Applies `diffs` from `modified` onto `original`, returning the result. */
export function applyLineChanges(
  original: vscode.TextDocument,
  modified: vscode.TextDocument,
  diffs: LineChange[],
): string {
  const result: string[] = [];
  let currentLine = 0;

  for (const diff of diffs) {
    const isInsertion = diff.originalEndLineNumber === 0;
    const isDeletion = diff.modifiedEndLineNumber === 0;

    let endLine = isInsertion
      ? diff.originalStartLineNumber
      : diff.originalStartLineNumber - 1;
    let endCharacter = 0;

    // A deletion at the very end of the document has to account for the
    // newline on the last line, which may itself have been deleted.
    if (isDeletion && diff.originalEndLineNumber === original.lineCount) {
      endLine -= 1;
      endCharacter = original.lineAt(endLine).range.end.character;
    }

    result.push(
      original.getText(new vscode.Range(currentLine, 0, endLine, endCharacter)),
    );

    if (!isDeletion) {
      let fromLine = diff.modifiedStartLineNumber - 1;
      let fromCharacter = 0;

      // An insertion at the very end must start after the last character of
      // the previous line so the correct EOL is carried over.
      if (isInsertion && diff.originalStartLineNumber === original.lineCount) {
        fromLine -= 1;
        fromCharacter = modified.lineAt(fromLine).range.end.character;
      }

      result.push(
        modified.getText(
          new vscode.Range(
            fromLine,
            fromCharacter,
            diff.modifiedEndLineNumber,
            0,
          ),
        ),
      );
    }

    currentLine = isInsertion
      ? diff.originalStartLineNumber
      : diff.originalEndLineNumber;
  }

  result.push(
    original.getText(new vscode.Range(currentLine, 0, original.lineCount, 0)),
  );

  return result.join("");
}

/** Collapses selections into a minimal set of whole-line ranges. */
export function toLineRanges(
  selections: readonly vscode.Selection[],
  textDocument: vscode.TextDocument,
): vscode.Range[] {
  const lineRanges = selections.map((s) => {
    const startLine = textDocument.lineAt(s.start.line);
    const endLine = textDocument.lineAt(s.end.line);
    return new vscode.Range(startLine.range.start, endLine.range.end);
  });

  lineRanges.sort((a, b) => a.start.line - b.start.line);

  const result = lineRanges.reduce((acc, l) => {
    if (acc.length === 0) {
      acc.push(l);
      return acc;
    }

    const [last, ...rest] = acc;
    const intersection = l.intersection(last!);

    if (intersection) {
      return [intersection, ...rest];
    }

    if (l.start.line === last!.end.line + 1) {
      return [new vscode.Range(last!.start, l.end), ...rest];
    }

    return [l, ...acc];
  }, [] as vscode.Range[]);

  result.reverse();
  return result;
}

/** The range a change occupies in the modified document. */
export function getModifiedRange(
  textDocument: vscode.TextDocument,
  diff: LineChange,
): vscode.Range {
  if (diff.modifiedEndLineNumber === 0) {
    if (diff.modifiedStartLineNumber === 0) {
      return new vscode.Range(
        textDocument.lineAt(diff.modifiedStartLineNumber).range.end,
        textDocument.lineAt(diff.modifiedStartLineNumber).range.start,
      );
    } else if (textDocument.lineCount === diff.modifiedStartLineNumber) {
      return new vscode.Range(
        textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end,
        textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end,
      );
    }
    return new vscode.Range(
      textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end,
      textDocument.lineAt(diff.modifiedStartLineNumber).range.start,
    );
  }

  return new vscode.Range(
    textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.start,
    textDocument.lineAt(diff.modifiedEndLineNumber - 1).range.end,
  );
}

/** Narrows a change to the part of it the user actually selected. */
export function intersectDiffWithRange(
  textDocument: vscode.TextDocument,
  diff: LineChange,
  range: vscode.Range,
): LineChange | null {
  const modifiedRange = getModifiedRange(textDocument, diff);
  const intersection = range.intersection(modifiedRange);

  if (!intersection) {
    return null;
  }

  if (diff.modifiedEndLineNumber === 0) {
    return diff;
  }

  const modifiedStartLineNumber = intersection.start.line + 1;
  const modifiedEndLineNumber = intersection.end.line + 1;

  // Same line count on both sides means we can map line by line; otherwise
  // fall back to the whole original range, which is the safe over-approximation.
  if (
    diff.originalEndLineNumber - diff.originalStartLineNumber ===
    diff.modifiedEndLineNumber - diff.modifiedStartLineNumber
  ) {
    const delta = modifiedStartLineNumber - diff.modifiedStartLineNumber;
    const length = modifiedEndLineNumber - modifiedStartLineNumber;

    return {
      originalStartLineNumber: diff.originalStartLineNumber + delta,
      originalEndLineNumber: diff.originalStartLineNumber + delta + length,
      modifiedStartLineNumber,
      modifiedEndLineNumber,
    };
  }

  return {
    originalStartLineNumber: diff.originalStartLineNumber,
    originalEndLineNumber: diff.originalEndLineNumber,
    modifiedStartLineNumber,
    modifiedEndLineNumber,
  };
}

/** Swaps the two sides, turning a stage into a revert. */
export function invertLineChange(diff: LineChange): LineChange {
  return {
    modifiedStartLineNumber: diff.originalStartLineNumber,
    modifiedEndLineNumber: diff.originalEndLineNumber,
    originalStartLineNumber: diff.modifiedStartLineNumber,
    originalEndLineNumber: diff.modifiedEndLineNumber,
  };
}

/*
 * NOTE: the upstream git extension also carries `toLineChanges` and helpers
 * that read `TextEditor.diffInformation`. That property is a PROPOSED VS Code
 * API (`textEditorDiffInformation`), usable only by extensions shipped inside
 * VS Code or run with proposed APIs enabled. Checkpoint gets the same
 * information from the daemon's `getLineChanges` instead, which keeps these
 * flows on stable API and reuses the diff logic the CLI already exercises.
 */

/**
 * Context VS Code hands the diff-editor gutter actions.
 *
 * `originalWithModifiedChanges` is the editor's own computation of "the
 * original with this block applied", so the Stage Block path needs no diff
 * maths at all on our side.
 */
export interface DiffEditorSelectionHunkToolbarContext {
  mapping: unknown;
  /** The original text with the selected modified changes applied. */
  originalWithModifiedChanges: string;
  modifiedUri: vscode.Uri;
  originalUri: vscode.Uri;
}
