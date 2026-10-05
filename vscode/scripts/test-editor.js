#!/usr/bin/env node
'use strict';
// The extension in a real editor, against the real language server:
// test/editor.js runs inside it with a workspace of two projects open,
// test/fixture and a copy of it named `second`.
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kflat-editor-'));
  const project = path.join(scratch, 'fixture');
  const second = path.join(scratch, 'second');
  fs.cpSync(path.join(extension, 'test', 'fixture'), project, { recursive: true });
  fs.cpSync(path.join(extension, 'test', 'fixture'), second, { recursive: true });
  const manifest = path.join(second, 'kf.toml');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace('"fixture"', '"second"'));
  const workspace = path.join(scratch, 'two.code-workspace');
  fs.writeFileSync(
    workspace,
    JSON.stringify({
      folders: [{ path: project }, { path: second }],
      settings: { 'kflat.kompPath': process.env.KOMP_BIN || 'komp', 'kflat.warnOnStaleBinary': false },
    })
  );
  try {
    await runTests({
      vscodeExecutablePath: process.env.CODE_BIN,
      extensionDevelopmentPath: extension,
      extensionTestsPath: path.join(extension, 'test', 'editor.js'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--no-sandbox'],
    });
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main();
