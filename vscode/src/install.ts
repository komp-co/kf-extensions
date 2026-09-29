// What to say when `komp lsp` does not start: komp is missing, or it has no
// `komp_lsp` to hand the command to.

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { kompPath } from './client';

const INSTALL_DOCS = 'https://github.com/komp-co/komp/blob/main/docs/book/src/start/installing.md';

/** Whether `komp` answers `--version` at all. */
function kompRuns(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(kompPath(), ['--version'], { timeout: 10000 }, (error) => resolve(!error));
  });
}

/**
 * One prompt naming what is missing and offering the fix. Resolves to true
 * when the user chose to install the server, so the caller can start it again.
 */
export async function offerInstall(): Promise<boolean> {
  if (!(await kompRuns())) {
    const open = 'How to install komp';
    const choice = await vscode.window.showErrorMessage(
      `KFlat: \`${kompPath()}\` does not run. Install kflat, or set kflat.kompPath to your komp.`,
      open,
    );
    if (choice === open) await vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS));
    return false;
  }
  const install = 'Install komp_lsp';
  const choice = await vscode.window.showWarningMessage(
    'KFlat: the language server is not installed. `komp tool install komp_lsp` installs it.',
    install,
  );
  if (choice !== install) return false;
  const task = new vscode.Task(
    { type: 'komp', command: 'tool install komp_lsp' },
    vscode.TaskScope.Workspace,
    'install komp_lsp',
    'komp',
    new vscode.ProcessExecution(kompPath(), ['tool', 'install', 'komp_lsp']),
  );
  const execution = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const done = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution !== execution) return;
      done.dispose();
      resolve(event.exitCode === 0);
    });
  });
}
