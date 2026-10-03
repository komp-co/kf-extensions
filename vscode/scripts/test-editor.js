#!/usr/bin/env node
'use strict';
// The extension in a real editor, against the real language server:
// test/editor.js runs inside it with test/fixture open.
//
//   npm run test-editor
//
// It needs komp, with the language server installed (`komp tool install
// komp_lsp`); KOMP_BIN names a komp that is not on PATH. CODE_BIN names the
// editor to run, else a VS Code is downloaded. Without a display, run it
// under `xvfb-run -a`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extension = path.resolve(__dirname, '..');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kflat-editor-'));
  fs.cpSync(path.join(extension, 'test', 'fixture'), project, { recursive: true });
  fs.mkdirSync(path.join(project, '.vscode'));
  fs.writeFileSync(
    path.join(project, '.vscode', 'settings.json'),
    JSON.stringify({ 'kflat.kompPath': process.env.KOMP_BIN || 'komp', 'kflat.warnOnStaleBinary': false })
  );
  try {
    await runTests({
      vscodeExecutablePath: process.env.CODE_BIN,
      extensionDevelopmentPath: extension,
      extensionTestsPath: path.join(extension, 'test', 'editor.js'),
      launchArgs: [project, '--disable-extensions', '--disable-workspace-trust', '--no-sandbox'],
    });
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}

main();
