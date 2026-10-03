'use strict';
// KFlat for VS Code. Every editor feature comes from the language server,
// `komp lsp`, one per project; the extension starts it, and runs the
// commands its Run and Test lenses name. Highlighting needs none of this:
// the TextMate grammar paints offline.

const vscode = require('vscode');
const { LanguageClient } = require('vscode-languageclient/node');
const path = require('node:path');
const projects = require('./projects');
const stale = require('./stale');

// A test file is its own language only so it can carry its own icon.
const SERVED_LANGUAGES = ['kflat', 'kflat-test', 'kflat-manifest', 'kflat-lints'];

/** Project root -> its LanguageClient. */
const clients = new Map();
/** Project roots whose server failed to start; retried on restart. */
const failed = new Set();

let output;

function activate(context) {
  output = vscode.window.createOutputChannel('KFlat', { log: true });
  context.subscriptions.push(
    output,
    vscode.workspace.onDidOpenTextDocument(serve),
    vscode.commands.registerCommand('kflat.restartServer', restartAll),
    vscode.commands.registerCommand('kflat.run', (dir) => runLens('kflat.run', [dir])),
    vscode.commands.registerCommand('kflat.test', (dir, name) => runLens('kflat.test', [dir, name])),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('kflat.kompPath')) restartAll();
    })
  );
  for (const doc of vscode.workspace.textDocuments) serve(doc);
}

function deactivate() {
  return stopAll();
}

const config = () => vscode.workspace.getConfiguration('kflat');
const kompPath = () => config().get('kompPath', 'komp');

/// Starts the server for `doc`'s project unless one is running.
function serve(doc) {
  if (doc.uri.scheme !== 'file' || !SERVED_LANGUAGES.includes(doc.languageId)) return;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const root = projects.projectRootFor(doc.uri.fsPath, folder ? folder.uri.fsPath : null);
  if (!root || clients.has(root) || failed.has(root)) return;
  warnIfStaleBinary();

  const komp = kompPath();
  const client = new LanguageClient(
    'kflat',
    'KFlat',
    { command: komp, args: ['lsp'], options: { cwd: root } },
    {
      documentSelector: SERVED_LANGUAGES.map((language) => ({
        scheme: 'file',
        language,
        pattern: `${projects.globEscape(root)}/**`,
      })),
      workspaceFolder: { uri: vscode.Uri.file(root), name: path.basename(root), index: 0 },
      outputChannel: output,
    }
  );
  client.registerFeature(RUN_COMMANDS);
  clients.set(root, client);
  client.start().catch((error) => {
    clients.delete(root);
    failed.add(root);
    client.dispose().catch(() => {});
    reportStartFailure(komp, root, error);
  });
}

/// Tells the server this client runs `kflat.run` and `kflat.test`, so it
/// offers the Run and Test lenses.
const RUN_COMMANDS = {
  fillClientCapabilities(capabilities) {
    capabilities.experimental = { ...capabilities.experimental, kflatRunCommands: true };
  },
  initialize() {},
  getState() {
    return { kind: 'static' };
  },
  clear() {},
};

function reportStartFailure(komp, root, error) {
  output.info(`could not start \`${komp} lsp\` in ${root}: ${error && error.message}`);
  const install = 'Install komp_lsp';
  const settings = 'Set kflat.kompPath';
  vscode.window
    .showErrorMessage(
      `KFlat: \`${komp} lsp\` did not start. It needs komp on PATH (or kflat.kompPath) ` +
        'and the language server, which `komp tool install komp_lsp` installs.',
      install,
      settings
    )
    .then((choice) => {
      if (choice === install) installServer(komp);
      if (choice === settings) vscode.commands.executeCommand('workbench.action.openSettings', 'kflat.kompPath');
    });
}

/// Runs `komp tool install komp_lsp` as a task, then starts the servers.
function installServer(komp) {
  const task = kompTask('install komp_lsp', komp, ['tool', 'install', 'komp_lsp'], undefined);
  const done = vscode.tasks.onDidEndTaskProcess((event) => {
    if (event.execution.task !== task) return;
    done.dispose();
    if (event.exitCode === 0) restartAll();
  });
  vscode.tasks.executeTask(task);
}

function runLens(command, args) {
  const words = projects.lensArguments(command, args);
  if (!words) return;
  const title = command === 'kflat.test' ? `test ${args[1]}` : `run ${path.basename(args[0])}`;
  vscode.tasks.executeTask(kompTask(title, kompPath(), words, args[0]));
}

function kompTask(title, komp, words, cwd) {
  const task = new vscode.Task(
    { type: 'kflat', command: words[0] },
    vscode.TaskScope.Workspace,
    title,
    'kflat',
    new vscode.ProcessExecution(komp, words, cwd ? { cwd } : undefined)
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  return task;
}

async function stopAll() {
  const running = [...clients.values()];
  clients.clear();
  failed.clear();
  await Promise.all(running.map((client) => client.stop().catch(() => {})));
}

async function restartAll() {
  await stopAll();
  for (const doc of vscode.workspace.textDocuments) serve(doc);
}

// ------------------------------------------------------- a stale compiler

/// `${binary}:${mtime}` pairs already decided on. Keying on the mtime as well
/// as the path re-arms the check when the binary is rebuilt.
const staleChecked = new Set();

/// A scratch komp under a checkout's `bin/` is a normal setup, and nothing
/// rebuilds it when the compiler changes. Every answer is that binary's
/// opinion, and a wrong answer looks exactly like a right one, so say so once
/// per build.
function warnIfStaleBinary() {
  if (!config().get('warnOnStaleBinary', true)) return;
  const komp = kompPath();
  const stamp = stale.binaryStamp(komp);
  if (!stamp) return;
  const key = `${stamp.path}:${stamp.builtMs}`;
  if (staleChecked.has(key)) return;
  staleChecked.add(key);

  stale.stalenessOf(komp, (report) => {
    if (!report) return;
    const name = path.relative(report.tree, report.binary) || report.binary;
    const message =
      `KFlat: ${name} is ${stale.describeAge(report.behindMs)} older than the newest ` +
      'change to compiler/, so every answer here comes from that older compiler. ' +
      'Rebuild it, or turn off kflat.warnOnStaleBinary.';
    output.info(message);
    vscode.window.showWarningMessage(message);
  });
}

module.exports = { activate, deactivate };
