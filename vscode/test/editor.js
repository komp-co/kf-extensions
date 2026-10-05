'use strict';
// Runs inside the editor that scripts/test-editor.js starts, with the
// extension loaded and the fixture project open: each case asks VS Code what
// a user would see, so what passes here is what the language server answers
// through the extension.

const vscode = require('vscode');

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    console.log(`FAIL  ${name}\n      ${detail}`);
    failures += 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// Polls `ask` until `ready` holds of its answer, or the time is up; the
/// first answers wait on the server checking the crate.
async function until(ask, ready, ms = 120000) {
  const end = Date.now() + ms;
  let answer;
  while (Date.now() < end) {
    answer = await ask();
    if (ready(answer)) return answer;
    await sleep(500);
  }
  return answer;
}

/// The position one character into `word` on the first line holding `line`.
function at(doc, line, word) {
  for (let i = 0; i < doc.lineCount; i += 1) {
    const text = doc.lineAt(i).text;
    if (text.includes(line)) return new vscode.Position(i, text.indexOf(word, text.indexOf(line)) + 1);
  }
  throw new Error(`no line holds ${line}`);
}

const hoverText = (hovers) =>
  (hovers || []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');

async function run() {
  // A block pasted into a body keeps its shape at the body's depth. First:
  // after the Run lens's task has run, a scripted paste is not reindented.
  const scratch = await vscode.workspace.openTextDocument({
    language: 'kflat',
    content: 'fun f(): int32 {\n    val a = 1\n    \n    return a\n}\n',
  });
  const pasting = await vscode.window.showTextDocument(scratch);
  await vscode.env.clipboard.writeText('if a > 0 {\n    println(a)\n}');
  // A window's first paste is never reindented, whatever the language: this
  // one only warms the editor up, and is undone.
  pasting.selection = new vscode.Selection(2, 4, 2, 4);
  await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
  await sleep(500);
  await vscode.commands.executeCommand('undo');
  pasting.selection = new vscode.Selection(2, 4, 2, 4);
  await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
  const pasted = await until(async () => scratch.getText(), (text) => text.includes('println'), 5000);
  check(
    'a pasted block is indented to where it lands',
    pasted.includes('    if a > 0 {\n        println(a)\n    }\n'),
    JSON.stringify(pasted)
  );

  const root = vscode.workspace.workspaceFolders[0].uri;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'src', 'main.kf'));
  await vscode.window.showTextDocument(doc);
  const uri = doc.uri;

  const call = at(doc, 'twice(total)', 'twice');
  const hover = await until(
    () => vscode.commands.executeCommand('vscode.executeHoverProvider', uri, call),
    (h) => hoverText(h).includes('twice(')
  );
  check('hover shows the callee', hoverText(hover).includes('twice(n: int32): int32'), hoverText(hover));

  const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, call);
  const declared = at(doc, 'fun twice', 'twice').line;
  check(
    'go to definition finds the declaration',
    (definitions || []).some((d) => (d.range || d.targetRange).start.line === declared),
    JSON.stringify(definitions)
  );

  const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, call);
  check('find references finds every use, the test file too', (references || []).length === 3, JSON.stringify(references));

  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
  const names = (symbols || []).map((s) => s.name);
  check('the outline names each declaration', ['Point', 'twice', 'main'].every((n) => names.includes(n)), names);

  const completion = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider',
    uri,
    at(doc, 'p.sum()', '.').translate(0, 1)
  );
  const fields = (completion ? completion.items : [])
    .filter((i) => i.detail === 'int32')
    .map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  check('completion after a dot offers the fields', fields.includes('x') && fields.includes('y'), fields);

  const hints = await vscode.commands.executeCommand(
    'vscode.executeInlayHintProvider',
    uri,
    new vscode.Range(0, 0, doc.lineCount, 0)
  );
  const hinted = (hints || []).map((h) => (typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join('')));
  check('an inlay hint gives a val its type', hinted.some((l) => l.includes('Point')), hinted);

  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
  const run = (lenses || []).find((l) => l.command && l.command.command === 'kflat.run');
  check('main carries a Run lens', run !== undefined, JSON.stringify(lenses));
  if (run) {
    const ended = new Promise((resolve) => {
      vscode.tasks.onDidEndTaskProcess((event) => resolve(event.exitCode));
    });
    await vscode.commands.executeCommand(run.command.command, ...run.command.arguments);
    const code = await Promise.race([ended, sleep(120000).then(() => 'timeout')]);
    check('the Run lens runs the crate', code === 0, `komp run ended with ${code}`);
  }

  const implemented = await vscode.commands.executeCommand(
    'vscode.executeImplementationProvider',
    uri,
    at(doc, 'trait Measured', 'Measured')
  );
  const impl = at(doc, 'impl Measured', 'Measured').line;
  check(
    'go to implementation finds the impl',
    (implemented || []).some((l) => {
      const line = (l.range || l.targetRange).start.line;
      return line >= impl && line <= impl + 3;
    }),
    JSON.stringify(implemented)
  );

  // Formatting runs the project's `komp fmt` over the unsaved text.
  const testUri = vscode.Uri.joinPath(root, 'src', 'main_test.kf');
  const testDoc = await vscode.workspace.openTextDocument(testUri);
  const testEditor = await vscode.window.showTextDocument(testDoc);
  const spaced = at(testDoc, 'twice(3), 6', ',');
  await testEditor.edit((edit) => edit.insert(spaced, '    '));
  const formatting = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', testUri, {
    tabSize: 4,
    insertSpaces: true,
  });
  const formatted = new vscode.WorkspaceEdit();
  formatted.set(testUri, formatting || []);
  await vscode.workspace.applyEdit(formatted);
  check('formatting undoes the extra spaces', testDoc.getText().includes('twice(3), 6'), testDoc.getText());

  // kf.toml's lenses run komp in the server; each project's goes to its own.
  const manifestLenses = async (folder) => {
    const manifest = vscode.Uri.joinPath(folder, 'kf.toml');
    await vscode.workspace.openTextDocument(manifest);
    return until(
      () => vscode.commands.executeCommand('vscode.executeCodeLensProvider', manifest),
      (l) => (l || []).length > 0
    );
  };
  const named = (lenses, command) => (lenses || []).find((l) => l.command && l.command.command === command);
  const fetch = named(await manifestLenses(root), 'komp.fetch');
  check('kf.toml carries Fetch and Update lenses', fetch !== undefined, 'no komp.fetch lens');
  const accepted = async (lens) => {
    try {
      await vscode.commands.executeCommand(lens.command.command, ...lens.command.arguments);
      return 'accepted';
    } catch (error) {
      return `${error.message || error}`;
    }
  };
  if (fetch) check('the Fetch lens reaches the server', (await accepted(fetch)) === 'accepted', await accepted(fetch));

  const secondRoot = vscode.workspace.workspaceFolders[1].uri;
  const secondDoc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(secondRoot, 'src', 'main.kf'));
  await vscode.window.showTextDocument(secondDoc);
  const secondHover = await until(
    () => vscode.commands.executeCommand('vscode.executeHoverProvider', secondDoc.uri, at(secondDoc, 'twice(total)', 'twice')),
    (h) => hoverText(h).includes('twice(')
  );
  check('a second project starts a server of its own', hoverText(secondHover).includes('twice('), hoverText(secondHover));
  const secondFetch = named(await manifestLenses(secondRoot), 'komp.fetch');
  check(
    "the second project's Fetch lens reaches its server",
    secondFetch !== undefined && (await accepted(secondFetch)) === 'accepted',
    JSON.stringify(secondFetch)
  );

  const editor = await vscode.window.showTextDocument(doc);
  const field = at(doc, 'doubled - p.x', 'x');
  await editor.edit((edit) => edit.replace(new vscode.Range(field.translate(0, -1), field), 'z'));
  const diagnostics = await until(
    async () => vscode.languages.getDiagnostics(uri),
    (d) => d.length > 0
  );
  check(
    'an edit is diagnosed before it is saved',
    diagnostics.some((d) => d.range.start.line === field.line),
    JSON.stringify(diagnostics.map((d) => d.message))
  );

  if (failures > 0) throw new Error(`${failures} editor case(s) failed`);
}

module.exports = { run };
