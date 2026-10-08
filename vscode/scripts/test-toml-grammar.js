#!/usr/bin/env node
'use strict';
// The grammar for kf.toml, kf.lock and lint.toml, tokenized with the engine
// VS Code uses. The cases pin the scopes a theme paints; the sweep runs every
// such file in a kf-lang checkout and fails on any text left unscoped or a
// string still open at end of file.

const fs = require('node:fs');
const path = require('node:path');
const oniguruma = require('vscode-oniguruma');
const textmate = require('vscode-textmate');

// A kf-lang checkout: `KFLAT_REPO`, or `kf-lang` beside this kf-extensions checkout.
const REPO = process.env.KFLAT_REPO || path.resolve(__dirname, '..', '..', '..', 'kf-lang');
const GRAMMAR = path.resolve(__dirname, '..', 'syntaxes', 'kflat-toml.tmLanguage.json');
const SCOPE = 'source.toml.kflat';
const NAMES = new Set(['kf.toml', 'kf.lock', 'lint.toml']);

const CASES = [
  ['[dependencies]', [['dependencies', 'entity.name.section.toml']]],
  ['[[package]]', [['[[', 'punctuation.definition.table.toml'], ['package', 'entity.name.section.toml']]],
  ['json = "0.2"', [['json', 'variable.other.key.toml'], ['0.2', 'string.quoted.double.basic.toml']]],
  ['greet = { git = "file://x", tag = "v1" }', [
    ['greet', 'variable.other.key.toml'],
    ['git', 'variable.other.key.toml'],
    ['tag', 'variable.other.key.toml'],
    [',', 'punctuation.separator.toml'],
  ]],
  ['max = 40 # columns', [['40', 'constant.numeric.toml'], ['# columns', 'comment.line.number-sign.toml']]],
  ['deny = true', [['true', 'constant.language.boolean.toml']]],
  ["path = 'C:\\no\\escapes'", [["C:\\no\\escapes", 'string.quoted.single.literal.toml']]],
];

let failures = 0;

function report(what, detail) {
  failures++;
  process.stderr.write(`FAIL ${what}\n     ${detail}\n`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (NAMES.has(entry.name)) out.push(p);
  }
  return out;
}

async function loadGrammar() {
  await oniguruma.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope) =>
      scope === SCOPE ? textmate.parseRawGrammar(fs.readFileSync(GRAMMAR, 'utf8'), GRAMMAR) : null,
  });
  return registry.loadGrammar(SCOPE);
}

function tokenize(grammar, lines) {
  let stack = textmate.INITIAL;
  const tokens = [];
  lines.forEach((line, i) => {
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    for (const t of result.tokens) tokens.push({ line: i + 1, text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes });
  });
  return { tokens, stack };
}

async function main() {
  const grammar = await loadGrammar();
  for (const [source, expectations] of CASES) {
    const { tokens } = tokenize(grammar, [source]);
    for (const [text, scope] of expectations) {
      const hit = tokens.find((t) => t.text === text);
      if (!hit) report(`${JSON.stringify(source)} -> ${JSON.stringify(text)}`, 'no such token');
      else if (!hit.scopes.includes(scope)) {
        report(`${JSON.stringify(source)} -> ${JSON.stringify(text)}`, `expected ${scope}, got ${hit.scopes.join(' ')}`);
      }
    }
  }
  const files = walk(REPO);
  if (files.length === 0) report('sweep', 'found no manifests to check');
  for (const file of files) {
    const { tokens, stack } = tokenize(grammar, fs.readFileSync(file, 'utf8').split('\n'));
    for (const t of tokens) {
      if (t.text.trim() && t.scopes.length === 1) {
        report(`${path.relative(REPO, file)}:${t.line}`, `unscoped text ${JSON.stringify(t.text)}`);
      }
    }
    if (stack.depth > 1) report(path.relative(REPO, file), `still open at end of file (depth ${stack.depth})`);
  }
  process.stdout.write(`toml cases: ${CASES.length}\ntoml sweep: ${files.length} files\n`);
  if (failures) {
    process.stderr.write(`\n${failures} failure${failures === 1 ? '' : 's'}\n`);
    process.exit(1);
  }
  process.stdout.write('ok\n');
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e}\n`);
  process.exit(1);
});
