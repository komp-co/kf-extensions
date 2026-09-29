// The language client: `komp lsp` answers every question about `.kf` files,
// kf.toml and lint.toml, and the client shows what it says.

import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  StaticFeature,
} from 'vscode-languageclient/node';

/** Every language the server answers for, by the ids package.json gives. */
export const SERVED_LANGUAGES = ['kflat', 'kflat-test', 'kflat-manifest', 'kflat-lints'];

/**
 * Tells the server this client runs the Run and Test lenses' commands,
 * `kflat.run` and `kflat.test`, which extension.ts registers.
 */
const runCommands: StaticFeature = {
  fillClientCapabilities(capabilities) {
    capabilities.experimental = { ...(capabilities.experimental ?? {}), kflatRunCommands: true };
  },
  initialize() {},
  getState: () => ({ kind: 'static' }),
  clear() {},
};

/** The most times a server that crashed is started again in one session. */
const MAX_RESTARTS = 5;

/** The `komp` the settings name: a path, or a bare name found on `PATH`. */
export function kompPath(): string {
  return vscode.workspace.getConfiguration('kflat').get<string>('kompPath') || 'komp';
}

/** The folder `komp lsp` runs in: the first workspace folder, or none. */
function serverRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * A server that ran and then stopped is started again; one that never
 * answered `initialize` is left stopped, for the caller to say why.
 */
export function createClient(output: vscode.LogOutputChannel): LanguageClient {
  let answered = false;
  let restarts = 0;
  const run = { command: kompPath(), args: ['lsp'], options: { cwd: serverRoot() } };
  const serverOptions: ServerOptions = { run, debug: run };
  const clientOptions: LanguageClientOptions = {
    documentSelector: SERVED_LANGUAGES.map((language) => ({ scheme: 'file', language })),
    outputChannel: output,
    initializationFailedHandler: () => false,
    errorHandler: {
      error: () => ({ action: answered ? ErrorAction.Continue : ErrorAction.Shutdown }),
      closed: () => {
        if (!answered || restarts >= MAX_RESTARTS) return { action: CloseAction.DoNotRestart };
        restarts += 1;
        return { action: CloseAction.Restart };
      },
    },
  };
  const client = new LanguageClient('kflat', 'KFlat', serverOptions, clientOptions);
  client.registerFeature(runCommands);
  client.onDidChangeState((event) => {
    if (event.newState === State.Running) answered = true;
  });
  return client;
}
