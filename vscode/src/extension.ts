// KFlat for VS Code: a client of `komp lsp`, with komp's tasks.

import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { createClient } from './client';
import { offerInstall } from './install';
import { KompTaskProvider } from './tasks';

let client: LanguageClient | undefined;
let output: vscode.LogOutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('KFlat', { log: true });
  context.subscriptions.push(
    output,
    vscode.tasks.registerTaskProvider('komp', new KompTaskProvider()),
    vscode.commands.registerCommand('kflat.restartServer', () => restart()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('kflat.kompPath')) void restart();
    }),
  );
  await start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}

/** Starts the server; when it cannot start, says why and offers the fix. */
async function start(): Promise<void> {
  client = createClient(output);
  try {
    await client.start();
  } catch (error) {
    output.error(`komp lsp did not start: ${error}`);
    client = undefined;
    if (await offerInstall()) await start();
  }
}

async function restart(): Promise<void> {
  const stopping = client;
  client = undefined;
  await stopping?.stop();
  await start();
}
