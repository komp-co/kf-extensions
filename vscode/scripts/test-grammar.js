#!/usr/bin/env node
'use strict';
// Tokenizes with the same engine VS Code uses, so what this asserts is what
// an editor actually paints.
//
//   npm install && npm test
//
// Two halves. The cases below pin the places a regex grammar is easy to get
// wrong — an operator that is a prefix of a longer one, a quote run, an
// interpolation slot. The sweep then runs every .kf in the repository
// through the grammar: real source compiles, so any token landing in
// `invalid.` is a false positive, and a string left open at end of file
// means a begin/end rule swallowed the rest of the file.

const fs = require('node:fs');
const path = require('node:path');
const oniguruma = require('vscode-oniguruma');
const textmate = require('vscode-textmate');

// A komp checkout: `KOMP_REPO`, or `komp` beside this kf-extensions checkout.
const REPO = process.env.KOMP_REPO || path.resolve(__dirname, '..', '..', '..', 'komp');
const GRAMMAR = path.resolve(__dirname, '..', 'syntaxes', 'kflat.tmLanguage.json');

// Each case: source line, then [text, innermost scope] for tokens to pin.
// Text not listed is not asserted about.
const CASES = [
  ['val a = b == c', [['==', 'keyword.operator.comparison.kflat']]],
  ['val a = b = c', [['=', 'keyword.operator.assignment.kflat']]],
  ['val a = b << 1', [['<<', 'keyword.operator.bitwise.kflat']]],
  ['val a = b < c', [['<', 'keyword.operator.comparison.kflat']]],
  ['val a = b <= c', [['<=', 'keyword.operator.comparison.kflat']]],
  ['for i in 0..n {', [['..', 'keyword.operator.range.kflat']]],
  ['for i in 0..=n {', [['..=', 'keyword.operator.range.kflat']]],
  ['val v = opt ?: return 0', [['?:', 'keyword.operator.optional.kflat']]],
  ['val v: int32? = x', [['?', 'keyword.operator.optional.kflat']]],
  ['    Some(k) => { }', [['=>', 'keyword.operator.arrow.kflat']]],
  ['val a = b && c || d', [['&&', 'keyword.operator.logical.kflat'], ['||', 'keyword.operator.logical.kflat']]],
  ['val a = b & c | d', [['&', 'keyword.operator.bitwise.kflat'], ['|', 'keyword.operator.bitwise.kflat']]],
  ['val a = b != c', [['!=', 'keyword.operator.comparison.kflat']]],

  ['fun scale(k: int32): void {', [
    ['fun', 'storage.type.kflat'],
    ['scale', 'entity.name.function.kflat'],
    ['int32', 'support.type.builtin.kflat'],
    ['void', 'support.type.builtin.kflat'],
  ]],
  ['pub struct Point {', [
    ['pub', 'storage.modifier.kflat'],
    ['struct', 'storage.type.kflat'],
    ['Point', 'entity.name.type.kflat'],
  ]],
  ['        self.x = 1', [['self', 'variable.language.self.kflat']]],
  ['    return x ?: null', [['null', 'constant.language.null.kflat']]],
  ['    val n = nullable', [['nullable', null]]],
  ['    if x is Some {', [['is', 'keyword.operator.expression.is.kflat']]],
  ['    val is = 1', [['is', null]]],

  // A doc comment is scoped apart from a plain one, and the `///` rule has to
  // stay ahead of the `//` rule or the longer prefix never gets its own scope.
  // Nothing else pins that ordering, and the difference is invisible until a
  // theme is asked to paint them differently.
  ['/// documented', [['/// documented', 'comment.line.documentation.kflat']]],
  ['// ordinary', [['// ordinary', 'comment.line.double-slash.kflat']]],
  ['val a = 1 /// trailing', [['/// trailing', 'comment.line.documentation.kflat']]],
  ['fun show(value: &dyn Display): void {', [
    ['dyn', 'storage.modifier.kflat'],
    ['Display', 'entity.name.type.kflat'],
  ]],

  // Call sites, field access, and names introduced with a type.
  ['    xs.push(7)', [['push', 'entity.name.function.call.kflat']]],
  ['    val n = intern(joined.as_str())', [
    ['intern', 'entity.name.function.call.kflat'],
    ['as_str', 'entity.name.function.call.kflat'],
  ]],
  ['    val xs = List.new<int32>()', [['new', 'entity.name.function.call.kflat']]],
  ['    val n = alloc_array<Ptr<uint8>>(4)', [['alloc_array', 'entity.name.function.call.kflat']]],
  ['    (*module).crate = crate', [['crate', 'variable.other.property.kflat']]],
  ['fun f(a: int32, b: str): void {', [
    ['a', 'variable.parameter.kflat'],
    ['b', 'variable.parameter.kflat'],
  ]],
  ['    val p = Point { x: 1, y: 2 }', [['x', 'variable.parameter.kflat']]],
  // A keyword before `(` stays a keyword: #keywords is tried first, and a
  // same-position tie goes to whichever is listed earlier.
  ['    when (opt) {', [['when', 'keyword.control.kflat']]],
  ['    if (a) {', [['if', 'keyword.control.kflat']]],
  ['    while (a) {', [['while', 'keyword.control.kflat']]],
  // An UpperCamelCase name before `(` is a variant or a struct, not a call.
  ['    val o = Option.Some(1)', [['Some', 'entity.name.type.kflat']]],
  ['@test', [['@test', 'storage.type.annotation.kflat']]],
  ['import core.string.*', [
    ['import', 'keyword.control.import.kflat'],
    ['core.string', 'entity.name.namespace.kflat'],
    ['.*', 'keyword.operator.wildcard.kflat'],
  ]],
  ['/// a doc comment', [['/// a doc comment', 'comment.line.documentation.kflat']]],
  ['// a comment', [['// a comment', 'comment.line.double-slash.kflat']]],

  // Every literal form the lexer reads is painted as one. These four were
  // asserted as errors here for as long as the lexer rejected them; it
  // reads all four now, and the expectations moved with it.
  ['val a = 255', [['255', 'constant.numeric.integer.kflat']]],
  ['val a = 0xff', [['0xff', 'constant.numeric.integer.kflat']]],
  ['val a = 1.5', [['1.5', 'constant.numeric.float.kflat']]],
  ['val a = 1_000', [['1_000', 'constant.numeric.integer.kflat']]],
  ["val a = 'x'", [["'x'", 'constant.character.kflat']]],

  ['val s = "hi ${n} there\\n"', [
    ['${', 'punctuation.section.embedded.begin.kflat'],
    ['n', 'meta.embedded.line.kflat'],
    ['}', 'punctuation.section.embedded.end.kflat'],
    ['\\n', 'constant.character.escape.kflat'],
  ]],
  // Triple-quoted strings are raw, but a slot in one is still code.
  ['val s = """a ${x} b"""', [
    ['${', 'punctuation.section.embedded.begin.kflat'],
    ['x', 'meta.embedded.line.kflat'],
  ]],
  ['val s = """a \\n b"""', [['a \\n b', 'string.quoted.triple.kflat']]],
  // A block's `}` inside a slot does not close the slot.
  ['val s = "${if a { b } else { c }} tail"', [
    ['else', 'keyword.control.kflat'],
    [' tail', 'string.quoted.double.kflat'],
  ]],
  // A run of four closes on its last three, so this holds `say "hi"`.
  ['val s = """say "hi""""', [['say "hi"', 'string.quoted.triple.kflat']]],
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
    else if (entry.name.endsWith('.kf')) out.push(p);
  }
  return out;
}

async function loadGrammar() {
  await oniguruma.loadWASM(
    fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer
  );
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope) =>
      scope === 'source.kflat'
        ? textmate.parseRawGrammar(fs.readFileSync(GRAMMAR, 'utf8'), GRAMMAR)
        : null,
  });
  const grammar = await registry.loadGrammar('source.kflat');
  if (!grammar) throw new Error(`could not load ${GRAMMAR}`);
  return grammar;
}

function tokenize(grammar, lines) {
  let stack = textmate.INITIAL;
  const tokens = [];
  for (let i = 0; i < lines.length; i++) {
    const result = grammar.tokenizeLine(lines[i], stack);
    stack = result.ruleStack;
    for (const t of result.tokens) {
      tokens.push({ line: i + 1, text: lines[i].slice(t.startIndex, t.endIndex), scopes: t.scopes });
    }
  }
  return { tokens, stack };
}

function runCases(grammar) {
  for (const [source, expectations] of CASES) {
    const { tokens } = tokenize(grammar, [source]);
    for (const [text, scope] of expectations) {
      const hit = tokens.find((t) => t.text === text) || tokens.find((t) => t.text.trim() === text);
      if (!hit) {
        const got = tokens.filter((t) => t.text.trim()).map((t) => JSON.stringify(t.text));
        report(`${JSON.stringify(source)} -> ${JSON.stringify(text)}`, `no such token; got ${got.join(' ')}`);
        continue;
      }
      // A null scope: the word is left to the theme's plain text.
      if (scope === null ? hit.scopes.length !== 1 : !hit.scopes.includes(scope)) {
        report(`${JSON.stringify(source)} -> ${JSON.stringify(text)}`, `expected ${scope}, got ${hit.scopes.join(' ')}`);
      }
    }
  }
  process.stdout.write(`cases: ${CASES.length}\n`);
}

function runSweep(grammar) {
  const files = walk(REPO);
  if (files.length === 0) report('sweep', 'found no .kf files to check');
  let tokenCount = 0;
  for (const file of files) {
    const { tokens, stack } = tokenize(grammar, fs.readFileSync(file, 'utf8').split('\n'));
    tokenCount += tokens.length;
    for (const t of tokens) {
      if (!t.text.trim()) continue;
      if (t.scopes.some((s) => s.startsWith('invalid.'))) {
        report(
          `${path.relative(REPO, file)}:${t.line}`,
          `compiling source marked invalid: ${JSON.stringify(t.text)} (${t.scopes.at(-1)})`
        );
      }
    }
    if (stack.depth > 1) {
      report(path.relative(REPO, file), `a string or comment is still open at end of file (depth ${stack.depth})`);
    }
  }
  process.stdout.write(`sweep: ${files.length} files, ${tokenCount} tokens\n`);
}

async function main() {
  const grammar = await loadGrammar();
  runCases(grammar);
  runSweep(grammar);
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
