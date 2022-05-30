'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceContext } from './workspace';

export const log = vscode.window.createOutputChannel("Textfile_Comments")

/**
 * Get the path name of the workspace
 * workspace root, assumed to be the first item in the array
 * @param folders the workspace folder object from vscode (via: `vscode.workspace.workspaceFolders`)
 * From https://github.com/d-koppenhagen/vscode-code-review/blob/32d366f5cc5f49527bde306cf1730e6391f5ec66/src/utils/workspace-util.ts#L41
 */
export const getWorkspaceFolder = (folders: vscode.WorkspaceFolder[] | undefined, activeTextEditor?: vscode.TextEditor): string => {
  if (!folders || !folders[0] || !folders[0].uri || !folders[0].uri.fsPath) {
    // Edge-Case (See Issue #108): Handle the case we are not actually in an workspace but a single file has been picked for review in VSCode
    // In this case, the review file will be stored next to this file in the same directory
    const currentFile = activeTextEditor?.document.fileName;
    return currentFile ? path.dirname(currentFile) : '';
  }
  return folders[0].uri.fsPath;
};

export function activate(context: vscode.ExtensionContext) {
	let workspaceRoot: string = getWorkspaceFolder(
		vscode.workspace.workspaceFolders as vscode.WorkspaceFolder[],
		vscode.window.activeTextEditor,
	);
    const workspaceContext = new WorkspaceContext(context, workspaceRoot);
    workspaceContext.registerCommands();
  
    /**
     * detect when active editor changes and the workspace too
     */
    const activeTextEditorWorkspaceChangesRegistration = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri) {
        const newWorkspaceRoot = getWorkspaceFolder(
          [vscode.workspace.getWorkspaceFolder(editor.document.uri)] as vscode.WorkspaceFolder[],
          vscode.window.activeTextEditor,
        );
  
        if (workspaceContext.workspaceRoot === newWorkspaceRoot) {
          // Prevent refresh everything when workspace stays the same as before
          return;
        }
  
        workspaceContext.workspaceRoot = newWorkspaceRoot;
        workspaceContext.refreshCommands();
      }
    });

    context.subscriptions.push(activeTextEditorWorkspaceChangesRegistration);

}
