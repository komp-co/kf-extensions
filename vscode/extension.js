'use strict';
// KFlat diagnostics, outline, folding, hover, inlay hints, expand-
// selection, signature help, go-to-definition, find-references and
// semantic highlighting for VS Code.
//
// Runs `komp check --diagnostic-format=json` on a saved file's crate — the
// nearest ancestor holding a kf.toml — and publishes what it reports, and
// `komp query` for the outline, the folds, the expand-selection chain, and
// the types behind hover and inlay hints. The extension never parses .kf
// itself; the compiler is the single source of truth for what a file means,
// exactly as the Neovim bridge in ../kflat-lsp does.
//
// Highlighting needs none of this: the TextMate grammar is generated from
// the compiler's own keyword and operator tables and paints offline.

const vscode = require('vscode');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stale = require('./stale');

/** Per crate root: { running, dirty, published: Set<string> } */
const roots = new Map();
/** Directory -> crate root, or null when there is none above it. */
const rootCache = new Map();
/** Crate roots already warned about having no build output. */
const warnedUnbuilt = new Set();

let diagnostics;
let output;
let status;

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection('komp');
  output = vscode.window.createOutputChannel('KFlat');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = 'kflat.check';

  context.subscriptions.push(
    diagnostics,
    output,
    status,

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isKflat(doc) && config().get('checkOnSave', true)) check(doc);
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isKflat(doc) && config().get('checkOnOpen', true)) check(doc);
    }),

    vscode.commands.registerCommand('kflat.check', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || !isKflat(doc)) {
        vscode.window.showInformationMessage('KFlat: open a .kf file first.');
        return;
      }
      check(doc);
    }),

    manifestWatcher(),

    vscode.languages.registerDocumentSymbolProvider(KFLAT, {
      provideDocumentSymbols,
    }),
    vscode.languages.registerFoldingRangeProvider(KFLAT, {
      provideFoldingRanges,
    }),
    vscode.languages.registerHoverProvider(KFLAT, { provideHover }),
    vscode.languages.registerInlayHintsProvider(KFLAT, { provideInlayHints }),
    vscode.languages.registerSelectionRangeProvider(KFLAT, { provideSelectionRanges }),
    vscode.languages.registerSignatureHelpProvider(KFLAT, { provideSignatureHelp }, '(', ','),
    vscode.languages.registerCodeActionsProvider(KFLAT, { provideCodeActions }, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.languages.registerCompletionItemProvider(KFLAT, { provideCompletionItems }, '.'),
    vscode.languages.registerRenameProvider(KFLAT, { provideRenameEdits, prepareRename }),
    vscode.languages.registerReferenceProvider(KFLAT, { provideReferences }),
    vscode.languages.registerDefinitionProvider(KFLAT, { provideDefinition }),
    vscode.languages.registerDocumentSemanticTokensProvider(
      KFLAT,
      { provideDocumentSemanticTokens },
      SEMANTIC_LEGEND
    )
  );

  updateStatusVisibility();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateStatusVisibility)
  );

  for (const doc of vscode.workspace.textDocuments) {
    if (isKflat(doc) && config().get('checkOnOpen', true)) check(doc);
  }
}

function deactivate() {
  roots.clear();
  rootCache.clear();
}

// A test file is its own language only so it can carry its own icon.
const KFLAT_LANGUAGES = ['kflat', 'kflat-test'];
const KFLAT = KFLAT_LANGUAGES.map((language) => ({ language }));
const isKflat = (doc) => KFLAT_LANGUAGES.includes(doc.languageId) && doc.uri.scheme === 'file';
const config = () => vscode.workspace.getConfiguration('kflat');

/// An added or removed kf.toml changes which crate a file belongs to.
function manifestWatcher() {
  const watcher = vscode.workspace.createFileSystemWatcher('**/kf.toml');
  watcher.onDidCreate(() => rootCache.clear());
  watcher.onDidDelete(() => rootCache.clear());
  return watcher;
}

function updateStatusVisibility() {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && isKflat(doc)) status.show();
  else status.hide();
}

// -------------------------------------------------------------- crate roots

function crateRootFor(filePath) {
  let dir = path.dirname(filePath);
  const walked = [];
  for (;;) {
    if (rootCache.has(dir)) {
      const root = rootCache.get(dir);
      for (const d of walked) rootCache.set(d, root);
      return root;
    }
    walked.push(dir);
    if (fs.existsSync(path.join(dir, 'kf.toml'))) {
      for (const d of walked) rootCache.set(d, dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const d of walked) rootCache.set(d, null);
      return null;
    }
    dir = parent;
  }
}

// ------------------------------------------------------------- running komp

function check(doc) {
  const root = crateRootFor(doc.uri.fsPath);
  if (!root) {
    output.appendLine(`no kf.toml above ${doc.uri.fsPath}; nothing to check`);
    return;
  }
  schedule(root);
}

function schedule(root) {
  let state = roots.get(root);
  if (!state) {
    state = { running: false, dirty: false, published: new Set() };
    roots.set(root, state);
  }
  if (state.running) {
    // One queued re-run is enough: the next check reads the tree as it is.
    state.dirty = true;
    return;
  }
  state.running = true;
  status.text = '$(sync~spin) KFlat: checking';
  status.tooltip = `komp check ${root}`;

  run(root, (diags) => {
    publish(root, state, diags);
    state.running = false;
    if (state.dirty) {
      state.dirty = false;
      schedule(root);
    }
  });
}

function run(root, done) {
  warnIfNeverBuilt(root);
  warnIfStaleBinary();
  const bin = config().get('kompPath', 'komp');
  const timeout = config().get('checkTimeoutMs', 60000);

  // The crate root goes in as an absolute path deliberately: komp's crate
  // dedup mis-canonicalizes relative paths whose `..` escape the invocation
  // directory.
  execFile(
    bin,
    ['check', '--diagnostic-format=json', root],
    { cwd: root, timeout, maxBuffer: 32 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') {
        status.text = '$(error) KFlat: komp not found';
        status.tooltip = `Could not run "${bin}". Set kflat.kompPath.`;
        output.appendLine(`could not run "${bin}": ${error.message}`);
        done(null);
        return;
      }
      if (error && error.killed) {
        // Partial output would look like the crate had got smaller. Keep
        // what is on screen rather than clearing it on a timeout.
        output.appendLine(`komp check timed out after ${timeout}ms`);
        status.text = '$(warning) KFlat: check timed out';
        done(null);
        return;
      }
      if (stderr && stderr.trim()) output.appendLine(`komp stderr: ${stderr.trim()}`);

      const diags = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d && typeof d.message === 'string') diags.push(d);
        } catch {
          // Non-JSON chatter, e.g. a usage error. Surface it rather than
          // dropping it, but do not let it look like a diagnostic.
          output.appendLine(`komp: ${line.trim()}`);
        }
      }
      done(diags);
    }
  );
}

/// `komp check` cannot see the implicit core/alloc until a build has written
/// target/kflat, and reports every stdlib name as missing. Say so once,
/// rather than letting a wall of false errors be the first impression.
function warnIfNeverBuilt(root) {
  if (warnedUnbuilt.has(root)) return;
  warnedUnbuilt.add(root);
  if (fs.existsSync(path.join(root, 'target', 'kflat'))) return;
  const message =
    `KFlat: ${path.basename(root)} has never been built. ` +
    'Until `komp build` runs once, `komp check` reports every stdlib name as missing.';
  output.appendLine(message);
  vscode.window.showWarningMessage(message);
}

// ------------------------------------------------------- a stale compiler

/// `${binary}:${mtime}` pairs already decided on. Keying on the mtime as well
/// as the path re-arms the check when the binary is rebuilt, and keeps the
/// git calls behind it to one per build rather than one per save.
const staleChecked = new Set();

/// The normal setup is a scratch komp under `bin/` (AGENTS.md), and nothing
/// rebuilds it when the compiler changes. Every feature here is that binary's
/// opinion, so an old one answers with an old compiler's semantics -- and a
/// wrong answer looks exactly like a right one. Say so once per build.
function warnIfStaleBinary() {
  if (!config().get('warnOnStaleBinary', true)) return;
  const kompPath = config().get('kompPath', 'komp');
  const stamp = stale.binaryStamp(kompPath);
  if (!stamp) return; // Missing entirely is its own, louder message.
  const key = `${stamp.path}:${stamp.builtMs}`;
  if (staleChecked.has(key)) return;
  staleChecked.add(key);

  stale.stalenessOf(kompPath, (report) => {
    if (!report) return;
    const name = path.relative(report.tree, report.binary) || report.binary;
    const message =
      `KFlat: ${name} is ${stale.describeAge(report.behindMs)} older than the newest ` +
      'change to compiler/, so every answer here comes from that older compiler. ' +
      'Rebuild it, or turn off kflat.warnOnStaleBinary.';
    output.appendLine(message);
    vscode.window.showWarningMessage(message);
  });
}

// -------------------------------------------------------------- publishing

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  note: vscode.DiagnosticSeverity.Information,
};

function publish(root, state, diags) {
  if (diags === null) return; // komp never ran; keep what is on screen

  const byFile = new Map();
  for (const d of diags) {
    if (!d.file) continue; // no span, nothing to attach it to
    const file = path.resolve(root, d.file);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(d);
  }

  for (const stale of state.published) {
    if (!byFile.has(stale)) diagnostics.delete(vscode.Uri.file(stale));
  }

  let errors = 0;
  let warnings = 0;
  for (const [file, list] of byFile) {
    const toPosition = positionMapper(file);
    diagnostics.set(
      vscode.Uri.file(file),
      list.map((d) => {
        if (d.severity === 'error') errors++;
        else if (d.severity === 'warning') warnings++;
        return toDiagnostic(d, toPosition, root);
      })
    );
    rememberFixes(file, list, toPosition, root);
  }
  for (const stale of state.published) if (!byFile.has(stale)) FIXES.delete(stale);
  state.published = new Set(byFile.keys());

  status.text = errors
    ? `$(error) KFlat: ${errors} error${errors === 1 ? '' : 's'}`
    : warnings
      ? `$(warning) KFlat: ${warnings} warning${warnings === 1 ? '' : 's'}`
      : '$(check) KFlat: ok';
  status.tooltip = `komp check ${root}`;
}

/// Fixes from the last check, per file. A repair is computed once, when
/// the crate is checked; VS Code asks for code actions on every cursor
/// move, and a crate check is far too expensive for that.
const FIXES = new Map();

function rememberFixes(file, list, toPosition, root) {
  const kept = [];
  for (const d of list) {
    const fix = d.fix;
    if (!fix || !toPosition) continue;
    if (!Number.isInteger(fix.byte_start) || !Number.isInteger(fix.byte_end)) continue;
    kept.push({
      title: fix.title || 'apply fix',
      newText: fix.replacement ?? '',
      // A repair need not land in the file the diagnostic was reported in.
      file: fix.file || file,
      range: new vscode.Range(toPosition(fix.byte_start), toPosition(fix.byte_end)),
      // Offered where the PROBLEM is, which is not always where the repair
      // goes: an inserted import lands at the top of the file while the
      // unresolved name is far below it.
      at: toDiagnostic(d, toPosition, root).range,
    });
  }
  if (kept.length) FIXES.set(file, kept);
  else FIXES.delete(file);
}

/// Compared by LINE, and against the DIAGNOSTIC's range rather than the
/// repair's: VS Code asks with the cursor as an empty range, and an
/// inserted import lands at the top of the file while the name it fixes is
/// far below.
function provideCodeActions(doc, range) {
  const kept = FIXES.get(doc.uri.fsPath);
  if (!kept) return [];
  return kept
    .filter((f) => f.at.end.line >= range.start.line && f.at.start.line <= range.end.line)
    .map((f) => {
      const action = new vscode.CodeAction(f.title, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(vscode.Uri.file(f.file), f.range, f.newText);
      return action;
    });
}

function toDiagnostic(d, toPosition, root) {
  let range;
  if (toPosition && Number.isInteger(d.byte_start) && Number.isInteger(d.byte_end)) {
    range = new vscode.Range(
      toPosition(d.byte_start),
      toPosition(Math.max(d.byte_end, d.byte_start + 1))
    );
  } else {
    // Fall back to the compiler's 1-based line/column. Those columns are
    // byte counts, which only differ from the real ones on a non-ASCII line.
    const line = Math.max(0, (d.line ?? 1) - 1);
    const col = Math.max(0, (d.column ?? 1) - 1);
    range = new vscode.Range(line, col, line, col + 1);
  }
  const diag = new vscode.Diagnostic(range, d.message, SEVERITY[d.severity] ?? SEVERITY.error);
  diag.source = 'komp';
  // The lint that fired, when one did. Shown beside the message and
  // filterable; null for ordinary compiler errors, which have no name to
  // configure (schema_version 2).
  if (typeof d.code === 'string' && d.code) diag.code = d.code;
  // The supporting labels, which komp's text renderer prints as `= note:`
  // lines (schema_version 3). VS Code shows these under the message as
  // clickable jumps — the "first declared here" the note names.
  const related = toRelatedInformation(d, root);
  if (related) diag.relatedInformation = related;
  return diag;
}

/// A diagnostic's secondary labels as VS Code related information.
///
/// Each label names its own file, because a note routinely points into a
/// different one from the error it supports, so each gets its own position
/// mapper rather than reusing the diagnostic's. A label the compiler could
/// not place carries no file and is dropped: related information is a jump
/// target, and there is nowhere to jump to.
function toRelatedInformation(d, root) {
  if (!root || !Array.isArray(d.secondary) || d.secondary.length === 0) return undefined;
  const out = [];
  const mappers = new Map();
  for (const lbl of d.secondary) {
    if (!lbl || typeof lbl.message !== 'string' || !lbl.file) continue;
    const file = path.resolve(root, lbl.file);
    if (!mappers.has(file)) mappers.set(file, positionMapper(file));
    const toPosition = mappers.get(file);
    let range;
    if (toPosition && Number.isInteger(lbl.byte_start) && Number.isInteger(lbl.byte_end)) {
      range = new vscode.Range(
        toPosition(lbl.byte_start),
        toPosition(Math.max(lbl.byte_end, lbl.byte_start + 1))
      );
    } else {
      const line = Math.max(0, (lbl.line ?? 1) - 1);
      const col = Math.max(0, (lbl.column ?? 1) - 1);
      range = new vscode.Range(line, col, line, col + 1);
    }
    out.push(
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.file(file), range),
        lbl.message
      )
    );
  }
  return out.length ? out : undefined;
}

// -------------------------------------------------------- outline & folding

/** Distinguishes the scratch files of two queries racing in one session. */
let queryCounter = 0;

/// Run `komp query` over the buffer.
///
/// An unsaved buffer is staged through a temporary file and named with
/// `--overlay`, while `--file` stays the document's own path. The split
/// matters: an offset is into the text on screen, so the answer has to be
/// about that text, and a typed query has to find the file inside its own
/// crate to resolve anything at all. Handing komp the scratch copy as the
/// file would satisfy the first and break the second.
function query(what, doc, extraArgs, done) {
  const bin = config().get('kompPath', 'komp');
  const timeout = config().get('queryTimeoutMs', 30000);
  const target = doc.uri.fsPath;
  let scratch = null;
  if (doc.isDirty) {
    scratch = path.join(os.tmpdir(), `kflat-query-${process.pid}-${queryCounter++}.kf`);
    try {
      fs.writeFileSync(scratch, doc.getText());
    } catch (error) {
      output.appendLine(`could not stage the buffer for a query: ${error.message}`);
      scratch = null;
    }
  }
  const args = ['query', what, '--file', target]
    .concat(scratch ? ['--overlay', scratch] : [])
    .concat(extraArgs);
  execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
    if (scratch) fs.rm(scratch, () => {});
    if (error) {
      output.appendLine(`komp query ${what}: ${error.message}`);
      done(null);
      return;
    }
    let answer = null;
    try {
      answer = JSON.parse(stdout.trim().split('\n').pop() || 'null');
    } catch {
      output.appendLine(`komp query ${what}: unparseable answer`);
    }
    if (answer && answer.severity === 'error') {
      output.appendLine(`komp query ${what}: ${answer.message}`);
      answer = null;
    }
    done(answer);
  });
}

/// komp names kinds in KFlat's vocabulary; VS Code's enum lives here.
const SYMBOL_KIND = {
  function: vscode.SymbolKind.Function,
  method: vscode.SymbolKind.Method,
  extern: vscode.SymbolKind.Function,
  struct: vscode.SymbolKind.Struct,
  enum: vscode.SymbolKind.Enum,
  variant: vscode.SymbolKind.EnumMember,
  field: vscode.SymbolKind.Field,
  trait: vscode.SymbolKind.Interface,
  impl: vscode.SymbolKind.Object,
  type: vscode.SymbolKind.TypeParameter,
};

function provideDocumentSymbols(doc) {
  return new Promise((resolve) => {
    query('symbols', doc, [], (answer) => {
      if (!answer) return resolve([]);
      const toPosition = bufferPositionMapper(doc);
      resolve((answer.symbols ?? []).map((s) => toSymbol(s, toPosition)));
    });
  });
}

function toSymbol(symbol, toPosition) {
  const range = new vscode.Range(toPosition(symbol.byte_start), toPosition(symbol.byte_end));
  const node = new vscode.DocumentSymbol(
    symbol.name || '<anonymous>',
    symbol.detail || '',
    SYMBOL_KIND[symbol.kind] ?? vscode.SymbolKind.Object,
    range,
    // komp does not record where a declaration's name token is, so the
    // whole declaration stands in for it.
    range
  );
  node.children = (symbol.children ?? []).map((child) => toSymbol(child, toPosition));
  return node;
}

function provideFoldingRanges(doc) {
  return new Promise((resolve) => {
    query('folding', doc, [], (answer) => {
      if (!answer) return resolve([]);
      const toPosition = bufferPositionMapper(doc);
      const ranges = [];
      for (const r of answer.ranges ?? []) {
        const start = toPosition(r.byte_start).line;
        const end = toPosition(r.byte_end).line;
        // Nothing to collapse on a single line. komp leaves this filter
        // here because it is this side that knows where the lines are.
        if (end <= start) continue;
        ranges.push(
          new vscode.FoldingRange(
            start,
            end,
            r.kind === 'imports' ? vscode.FoldingRangeKind.Imports : undefined
          )
        );
      }
      resolve(ranges);
    });
  });
}

// ------------------------------------------------------------------- hover

/// Hover contents: what the cursor names, then what it is documented as.
///
/// The signature is preferred over the expression's type when both are
/// there — it already contains the return type, and `add(a: int32, b:
/// int32): int32` tells the reader more than `int32` does. The type is the
/// answer for everything with no declaration behind it: a literal, an
/// operator result, a field read.
function hoverMarkdown(answer) {
  const parts = [];
  const code = typeof answer.signature === 'string' ? answer.signature
             : typeof answer.type === 'string' ? answer.type
             : null;
  if (code) parts.push('```kflat\n' + code + '\n```');
  if (typeof answer.documentation === 'string' && answer.documentation !== '') {
    if (parts.length) parts.push('---');
    parts.push(answer.documentation);
  }
  return parts.join('\n');
}

function provideHover(doc, position) {
  return new Promise((resolve) => {
    const offset = byteOffsetOf(doc, position);
    query('hover', doc, ['--offset', String(offset)], (answer) => {
      if (!answer) return resolve(null);
      const value = hoverMarkdown(answer);
      if (!value) return resolve(null);
      const contents = new vscode.MarkdownString(value);
      // A declaration's own name covers no expression, so there is no span
      // to underline — and an empty range at 0 would point at the top of
      // the file. VS Code picks the word under the cursor when omitted.
      if (answer.byte_end > answer.byte_start) {
        const toPosition = bufferPositionMapper(doc);
        return resolve(new vscode.Hover(contents, new vscode.Range(
          toPosition(answer.byte_start),
          toPosition(answer.byte_end)
        )));
      }
      resolve(new vscode.Hover(contents));
    });
  });
}

function provideInlayHints(doc, range) {
  return new Promise((resolve) => {
    query('inlays', doc, [], (answer) => {
      if (!answer) return resolve([]);
      const toPosition = bufferPositionMapper(doc);
      const hints = [];
      for (const h of answer.inlays ?? []) {
        const at = toPosition(h.byte_offset);
        if (!range.contains(at)) continue;
        const hint = new vscode.InlayHint(at, h.label, vscode.InlayHintKind.Type);
        hint.paddingLeft = false;
        hints.push(hint);
      }
      resolve(hints);
    });
  });
}

function provideSelectionRanges(doc, positions) {
  // One chain per position, answered in the order they came in.
  return Promise.all(
    positions.map(
      (position) =>
        new Promise((resolve) => {
          const offset = byteOffsetOf(doc, position);
          query('selection', doc, ['--offset', String(offset)], (answer) => {
            const toPosition = bufferPositionMapper(doc);
            const ranges = answer ? answer.ranges ?? [] : [];
            // A SelectionRange links outward, so build from the far end.
            let node;
            for (let i = ranges.length - 1; i >= 0; i--) {
              const r = ranges[i];
              node = new vscode.SelectionRange(
                new vscode.Range(toPosition(r.byte_start), toPosition(r.byte_end)),
                node
              );
            }
            // Never hand back nothing: with no chain, the word under the
            // cursor is a better answer than refusing to expand at all.
            resolve(node ?? new vscode.SelectionRange(new vscode.Range(position, position)));
          });
        })
    )
  );
}

// komp names a member's role; VS Code wants a CompletionItemKind.
/// Member completion answers `field` and `method`; scope completion
/// answers the rest. A parameter maps to Variable because VS Code has no
/// separate kind for one.
const COMPLETION_KIND = {
  field: vscode.CompletionItemKind.Field,
  method: vscode.CompletionItemKind.Method,
  local: vscode.CompletionItemKind.Variable,
  parameter: vscode.CompletionItemKind.Variable,
  function: vscode.CompletionItemKind.Function,
  struct: vscode.CompletionItemKind.Struct,
  enum: vscode.CompletionItemKind.Enum,
  trait: vscode.CompletionItemKind.Interface,
  keyword: vscode.CompletionItemKind.Keyword,
  primitive: vscode.CompletionItemKind.Struct,
};

/// VS Code asks this before prompting for the new name, and shows the
/// thrown message when renaming is not possible here. Rejecting is the
/// documented way to say no.
function prepareRename(doc, position) {
  return new Promise((resolve, reject) => {
    const offset = byteOffsetOf(doc, position);
    query('rename', doc, ['--offset', String(offset)], (answer) => {
      if (!answer) return reject(new Error('cannot rename here'));
      if (!answer.ok || !answer.range) return reject(new Error(answer.error ?? 'cannot rename here'));
      const toPosition = positionMapper(answer.range.file);
      if (!toPosition) return reject(new Error('cannot rename here'));
      resolve(new vscode.Range(toPosition(answer.range.byte_start), toPosition(answer.range.byte_end)));
    });
  });
}

function provideRenameEdits(doc, position, newName) {
  return new Promise((resolve, reject) => {
    const offset = byteOffsetOf(doc, position);
    query('rename', doc, ['--offset', String(offset), '--new-name', String(newName)], (answer) => {
      if (!answer) return reject(new Error('cannot rename here'));
      // A refusal has to reject: resolving an empty WorkspaceEdit makes
      // VS Code report a successful rename that changed nothing.
      if (!answer.ok) return reject(new Error(answer.error ?? 'cannot rename here'));
      const edit = new vscode.WorkspaceEdit();
      for (const e of answer.edits ?? []) {
        const toPosition = positionMapper(e.file);
        if (!toPosition) continue;
        edit.replace(
          vscode.Uri.file(e.file),
          new vscode.Range(toPosition(e.byte_start), toPosition(e.byte_end)),
          newName
        );
      }
      resolve(edit);
    });
  });
}

function provideCompletionItems(doc, position) {
  return new Promise((resolve) => {
    const offset = byteOffsetOf(doc, position);
    query('completion', doc, ['--offset', String(offset)], (answer) => {
      if (!answer) return resolve([]);
      resolve((answer.items ?? []).map((it) => {
        const kind = COMPLETION_KIND[it.kind] ?? vscode.CompletionItemKind.Text;
        const item = new vscode.CompletionItem(it.label, kind);
        if (it.detail) item.detail = it.detail;
        return item;
      }));
    });
  });
}

function provideSignatureHelp(doc, position) {
  return new Promise((resolve) => {
    const offset = byteOffsetOf(doc, position);
    query('signature', doc, ['--offset', String(offset)], (answer) => {
      if (!answer || typeof answer.label !== 'string') return resolve(null);
      const signature = new vscode.SignatureInformation(answer.label);
      signature.parameters = (answer.parameters ?? []).map(
        (p) => new vscode.ParameterInformation(p.label)
      );
      const help = new vscode.SignatureHelp();
      help.signatures = [signature];
      help.activeSignature = 0;
      help.activeParameter = answer.active_parameter ?? 0;
      resolve(help);
    });
  });
}

// komp names a role; VS Code wants an index into a legend it is told up
// front. `property` is the protocol's word for a field.
const SEMANTIC_TYPES = ['variable', 'function', 'method', 'property', 'type'];
const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(SEMANTIC_TYPES, []);
const SEMANTIC_NAME = {
  variable: 'variable',
  function: 'function',
  method: 'method',
  field: 'property',
  type: 'type',
};

function provideDocumentSemanticTokens(doc) {
  return new Promise((resolve) => {
    query('tokens', doc, [], (answer) => {
      const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
      if (!answer) return resolve(builder.build());
      const toPosition = bufferPositionMapper(doc);
      for (const t of answer.tokens ?? []) {
        const start = toPosition(t.byte_start);
        const end = toPosition(t.byte_end);
        // A token spanning lines has no representation in the encoding.
        if (end.line !== start.line) continue;
        const name = SEMANTIC_NAME[t.type];
        if (!name) continue;
        builder.push(start.line, start.character, end.character - start.character, SEMANTIC_TYPES.indexOf(name));
      }
      resolve(builder.build());
    });
  });
}

function provideReferences(doc, position) {
  return new Promise((resolve) => {
    queryReferences(doc, position, (answer) => {
      if (!answer) return resolve([]);
      resolve((answer.references ?? []).map(toLocation));
    });
  });
}

function provideDefinition(doc, position) {
  return new Promise((resolve) => {
    queryReferences(doc, position, (answer) => {
      if (!answer || !answer.declaration) return resolve(null);
      resolve(toLocation(answer.declaration));
    });
  });
}

/// Both features read the same answer: the declaration the cursor names,
/// and every use of it.
function queryReferences(doc, position, done) {
  const offset = byteOffsetOf(doc, position);
  query('references', doc, ['--offset', String(offset)], done);
}

/// One span from a query into a Location. Each carries its own file, so
/// the byte-to-position mapping is per-entry.
function toLocation(entry) {
  const toPosition = positionMapper(entry.file);
  const range = toPosition
    ? new vscode.Range(toPosition(entry.byte_start), toPosition(entry.byte_end))
    : new vscode.Range(0, 0, 0, 0);
  return new vscode.Location(vscode.Uri.file(entry.file), range);
}

/// Position -> byte offset. VS Code counts UTF-16 code units and komp
/// counts bytes, so the text up to the cursor has to be measured, not
/// its length taken.
function byteOffsetOf(doc, position) {
  const upTo = doc.getText(new vscode.Range(new vscode.Position(0, 0), position));
  return Buffer.byteLength(upTo, 'utf8');
}

/// Byte offset -> Position over the buffer's own text, so an unsaved edit
/// does not shift every answer by the length of what was typed.
function bufferPositionMapper(doc) {
  return offsetMapper(Buffer.from(doc.getText(), 'utf8'));
}

/// Byte offset -> Position. komp counts bytes; VS Code counts UTF-16 code
/// units, so the two only agree on an all-ASCII line.
function positionMapper(file) {
  let content;
  try {
    content = fs.readFileSync(file);
  } catch {
    return null;
  }
  return offsetMapper(content);
}

function offsetMapper(content) {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0x0a) lineStarts.push(i + 1);
  }
  return (offset) => {
    const at = Math.min(Math.max(offset, 0), content.length);
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    const character = content.subarray(lineStarts[lo], at).toString('utf8').length;
    return new vscode.Position(lo, character);
  };
}

module.exports = { activate, deactivate };
