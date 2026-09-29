// `komp` tasks for each crate in the workspace: build, run, test and check,
// their diagnostics read by the `$komp` problem matcher.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { kompPath } from './client';

/** The task definition package.json declares under `taskDefinitions`. */
interface KompTaskDefinition extends vscode.TaskDefinition {
  command: string;
  crate?: string;
}

const COMMANDS: { command: string; group?: vscode.TaskGroup }[] = [
  { command: 'build', group: vscode.TaskGroup.Build },
  { command: 'run' },
  { command: 'test', group: vscode.TaskGroup.Test },
  { command: 'check' },
];

/** A `komp <command> <crate>` task; `crate` is relative to the folder. */
export function kompTask(folder: vscode.WorkspaceFolder, definition: KompTaskDefinition): vscode.Task {
  const crate = definition.crate ?? '.';
  const args = [...definition.command.split(' '), crate];
  const name = crate === '.' ? definition.command : `${definition.command} ${crate}`;
  const execution = new vscode.ProcessExecution(kompPath(), args, { cwd: folder.uri.fsPath });
  const task = new vscode.Task(definition, folder, name, 'komp', execution, '$komp');
  task.group = COMMANDS.find((c) => c.command === definition.command)?.group;
  return task;
}

/** Every directory holding a kf.toml, relative to `folder`, build output left out. */
async function crates(folder: vscode.WorkspaceFolder): Promise<string[]> {
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/kf.toml'),
    '**/{target,node_modules,.git}/**',
  );
  return found
    .map((uri) => path.relative(folder.uri.fsPath, path.dirname(uri.fsPath)) || '.')
    .sort();
}

export class KompTaskProvider implements vscode.TaskProvider {
  async provideTasks(): Promise<vscode.Task[]> {
    const tasks: vscode.Task[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const crate of await crates(folder)) {
        for (const { command } of COMMANDS) tasks.push(kompTask(folder, { type: 'komp', command, crate }));
      }
    }
    return tasks;
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const definition = task.definition as KompTaskDefinition;
    if (!definition.command || typeof task.scope !== 'object') return undefined;
    return kompTask(task.scope, definition);
  }
}
