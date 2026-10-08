#!/usr/bin/env node
'use strict';
// Generates syntaxes/kflat.tmLanguage.json from the compiler's own lexer tables.
//
// Keyword spellings come from `kw_str`, operator spellings from `op_str`,
// builtin type names from `RUNTIME_TYPE_NAMES` and the library types
// marked `@lang` — the same tables the
// compiler lexes and diagnoses with. Nothing here restates a spelling, so
// the grammar cannot drift from the language the way a hand-written one
// does. Adding a keyword or operator upstream makes this script fail until
// the new spelling is given a scope below, rather than silently dropping it.
//
//   node scripts/generate-grammar.js            # write the grammar
//   node scripts/generate-grammar.js --check    # fail if it is out of date
//
// What is hand-written: comments, string literals, numbers, and the
// declaration/type rules. Those are shapes, not spellings, and a regex
// grammar approximates them by construction — semantic tokens from a real
// KFlat language server are the eventual fix, not a longer regex.

const fs = require('node:fs');
const path = require('node:path');

// A kf-lang checkout: `KFLAT_REPO`, or `kf-lang` beside this kf-extensions checkout.
const REPO = process.env.KFLAT_REPO || path.resolve(__dirname, '..', '..', '..', 'kf-lang');
const OUT = path.resolve(__dirname, '..', 'syntaxes', 'kflat.tmLanguage.json');

const LEXER = path.join(REPO, 'compiler', 'kf-parse', 'src', 'lexer');
const KEYWORD_KF = path.join(LEXER, 'keyword.kf');
const OPERATOR_KF = path.join(LEXER, 'operator.kf');
const C_NAMES_KF = path.join(REPO, 'compiler', 'kf-core', 'src', 'names', 'c_names.kf');
const LIBS = path.join(REPO, 'libs');

// ------------------------------------------------------------ reading the compiler

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail(`cannot read ${path.relative(REPO, file)}: ${e.message}`);
  }
}

/// The body of a `fun <name>(...)` up to the closing brace at column 0.
function funBody(src, name, file) {
  const start = src.indexOf(`fun ${name}(`);
  if (start < 0) fail(`${path.relative(REPO, file)} no longer defines ${name}`);
  const end = src.indexOf('\n}\n', start);
  if (end < 0) fail(`${path.relative(REPO, file)}: ${name} has no closing brace`);
  return src.slice(start, end);
}

/// `Variant => "spelling"` arms, in declaration order.
///
/// The `return` is optional because both spellings of the same table
/// exist in the tree's history: these functions used to return from every
/// arm and now return one `when`. Accepting both means a refactor that
/// changes only where the keyword sits does not silently blind this
/// script — which is exactly what happened between 2026-08-06 and this
/// commit, leaving the grammar frozen.
function whenArmSpellings(src, funName, file) {
  const body = funBody(src, funName, file);
  const arms = [...body.matchAll(/^\s*(\w+)\s*=>\s*(?:return\s+)?"((?:[^"\\]|\\.)*)"/gm)];
  if (arms.length === 0) fail(`${funName} yielded no arms — its shape changed`);
  return arms.map((m) => ({ variant: m[1], spelling: JSON.parse(`"${m[2]}"`) }));
}

/// Variant names of `pub enum <name>`, ignoring doc comments.
function enumVariants(src, name, file) {
  const start = src.indexOf(`pub enum ${name} {`);
  if (start < 0) fail(`${path.relative(REPO, file)} no longer declares enum ${name}`);
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(src.indexOf('{', start) + 1, end);
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => {
      if (!/^\w+$/.test(l)) fail(`unexpected line in enum ${name}: ${l}`);
      return l;
    });
}

/// The names in `RUNTIME_TYPE_NAMES`.
function runtimeTypeNames(src) {
  const table = /val RUNTIME_TYPE_NAMES: str\[\] = \[([^\]]*)\]/.exec(src);
  if (!table) fail(`${path.relative(REPO, C_NAMES_KF)} no longer declares RUNTIME_TYPE_NAMES`);
  const names = [...table[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  if (names.length === 0) fail('RUNTIME_TYPE_NAMES yielded no names — its shape changed');
  return names;
}

/// The structs and enums the libraries mark `@lang`: `String`, `List` and
/// `Option` today, under whatever names the library gives them.
function langTypeNames() {
  const names = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (entry.name.endsWith('.kf') && !entry.name.endsWith('_test.kf')) {
        const marked = /@lang\("\w+"\)\s*\n(?:\s*(?:\/\/.*|@\w.*)\n)*\s*(?:pub\s+)?(?:struct|enum)\s+(\w+)/g;
        for (const m of read(p).matchAll(marked)) names.push(m[1]);
      }
    }
  };
  visit(LIBS);
  if (names.length === 0) fail('no struct or enum in libs/ is marked @lang — its shape changed');
  return names.sort();
}

// ------------------------------------------------------- spelling → scope

// Every keyword `kw_str` spells must appear here. A keyword added to the
// compiler without a scope is a hard error, not an uncolored word.
const KEYWORD_SCOPES = {
  'keyword.control.kflat': ['if', 'else', 'when', 'while', 'for', 'in', 'return', 'break', 'continue'],
  'keyword.control.import.kflat': ['import'],
  'keyword.operator.cast.kflat': ['as'],
  'constant.language.kflat': ['true', 'false'],
  'storage.type.kflat': ['fun', 'val', 'var', 'struct', 'enum', 'impl', 'trait', 'type'],
  // `dyn` sits here rather than with the type-introducers: it only ever
  // qualifies a borrow in type position (`&dyn Trait`), and the parser
  // poisons it anywhere else.
  'storage.modifier.kflat': ['pub', 'internal', 'extern', 'static', 'mutating', 'unsafe', 'dyn'],
};

// Same contract for operators. Punctuation that carries no meaning of its
// own is scoped as punctuation so themes leave it alone.
const OPERATOR_SCOPES = {
  'keyword.operator.comparison.kflat': ['==', '!=', '<=', '>=', '<', '>'],
  'keyword.operator.logical.kflat': ['&&', '||', '!'],
  'keyword.operator.arithmetic.kflat': ['+', '-', '*', '/', '%'],
  'keyword.operator.bitwise.kflat': ['<<', '&', '|', '^'],
  'keyword.operator.assignment.kflat': ['='],
  // `?:` binds-or-diverges, a trailing `?` marks an optional type, `?`
  // postfix propagates, `?.` short-circuits a member access, and `!!`
  // force-unwraps. All five are about absence, so a theme that paints one
  // paints them together. `?.` must precede `?` here for the same reason it
  // does in the lexer: longest match wins.
  'keyword.operator.optional.kflat': ['?:', '?.', '?', '!!'],
  'keyword.operator.range.kflat': ['..=', '..'],
  'keyword.operator.arrow.kflat': ['=>', '->'],
  'punctuation.accessor.kflat': ['.'],
  'punctuation.separator.kflat': [',', ':', ';'],
  'punctuation.brackets.kflat': ['(', ')', '{', '}', '[', ']'],
  // `@` only ever introduces an annotation, which #annotations paints whole.
  null: ['@'],
};

function scopeIndex(table, what) {
  const index = new Map();
  for (const [scope, spellings] of Object.entries(table)) {
    for (const s of spellings) {
      if (index.has(s)) fail(`${what} \`${s}\` is listed under two scopes`);
      index.set(s, scope === 'null' ? null : scope);
    }
  }
  return index;
}

/// Assign each spelling its scope, rejecting any the compiler grew or lost.
function scopeAll(spellings, table, what) {
  const index = scopeIndex(table, what);
  const scoped = [];
  for (const spelling of spellings) {
    if (!index.has(spelling)) {
      fail(
        `${what} \`${spelling}\` has no scope. It was added to the compiler; ` +
          `add it to the matching list in ${path.basename(__filename)}.`
      );
    }
    const scope = index.get(spelling);
    if (scope !== null) scoped.push({ spelling, scope });
  }
  for (const known of index.keys()) {
    if (!spellings.includes(known)) {
      fail(`\`${known}\` is scoped here but the compiler no longer spells it`);
    }
  }
  return scoped;
}

/// One pattern per (length, scope), longest spellings first.
///
/// TextMate picks the pattern that matches *earliest*, breaking ties by
/// list order — not by match length. So `==` must be tried before `=` or it
/// paints as two assignments, and `<<` before `<` or nested generics and
/// shifts collide. Bucketing by length and emitting longest-first is what
/// makes that ordering hold no matter how the scopes are grouped.
function operatorPatterns(scoped) {
  const byLength = new Map();
  for (const { spelling, scope } of scoped) {
    const key = `${spelling.length}\u0000${scope}`;
    if (!byLength.has(key)) byLength.set(key, { len: spelling.length, scope, spellings: [] });
    byLength.get(key).spellings.push(spelling);
  }
  return [...byLength.values()]
    .sort((a, b) => b.len - a.len)
    .map((g) => ({ name: g.scope, match: g.spellings.map(esc).join('|') }));
}

const RE_META = /[.*+?^${}()|[\]\\]/g;
const esc = (s) => s.replace(RE_META, '\\$&');

// A turbofish, as in `List.new<int32>()` or `alloc_array<Ptr<uint8>>(n)`.
// One level of nesting covers every call in the tree, and refusing parens
// inside is what stops `a < b` from opening a match that never closes.
const GENERIC_ARGS = '<[^<>()]*(?:<[^<>()]*>)?[^<>()]*>';

// ------------------------------------------------------------- the grammar

function build() {
  const keywordSrc = read(KEYWORD_KF);
  const operatorSrc = read(OPERATOR_KF);

  const keywords = whenArmSpellings(keywordSrc, 'kw_str', KEYWORD_KF);
  const operators = whenArmSpellings(operatorSrc, 'op_str', OPERATOR_KF);
  crossCheck(enumVariants(keywordSrc, 'Keyword', KEYWORD_KF), keywords, 'Keyword');
  crossCheck(enumVariants(operatorSrc, 'Operator', OPERATOR_KF), operators, 'Operator');

  const scopedKeywords = scopeAll(keywords.map((k) => k.spelling), KEYWORD_SCOPES, 'keyword');
  const scopedOperators = scopeAll(operators.map((o) => o.spelling), OPERATOR_SCOPES, 'operator');

  const builtinTypes = [...langTypeNames(), ...runtimeTypeNames(read(C_NAMES_KF))];

  // Keywords are `\b`-delimited, so one alternation per scope is enough —
  // no keyword is a prefix of another once whole words are required.
  const byScope = new Map();
  for (const { spelling, scope } of scopedKeywords) {
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(spelling);
  }
  const keywordPatterns = [...byScope].map(([scope, words]) => ({
    name: scope,
    match: `\\b(?:${words.map(esc).join('|')})\\b`,
  }));

  const opPatterns = operatorPatterns(scopedOperators);

  return {
    $schema:
      'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    name: 'KFlat',
    scopeName: 'source.kflat',
    fileTypes: ['kf'],
    // GENERATED — see scripts/generate-grammar.js. Do not edit by hand.
    patterns: [
      { include: '#comments' },
      { include: '#strings' },
      { include: '#annotations' },
      { include: '#imports' },
      { include: '#declarations' },
      { include: '#keywords' },
      { include: '#calls' },
      { include: '#properties' },
      { include: '#annotated-names' },
      { include: '#literals' },
      { include: '#types' },
      { include: '#operators' },
    ],
    repository: {
      comments: {
        patterns: [
          {
            name: 'comment.line.documentation.kflat',
            match: '///.*$',
          },
          {
            name: 'comment.line.double-slash.kflat',
            match: '//.*$',
          },
        ],
      },

      strings: {
        patterns: [
          // Triple-quoted strings are raw: no escapes, but `${` still opens a
          // slot. A run of four or more quotes closes on its *last* three, so
          // `"""say "hi""""` holds `say "hi"` — hence the lookahead.
          {
            name: 'string.quoted.triple.kflat',
            begin: '"""',
            end: '"""(?!")',
            patterns: [{ include: '#interpolation' }],
          },
          {
            name: 'string.quoted.double.kflat',
            begin: '"',
            end: '"',
            patterns: [
              { name: 'constant.character.escape.kflat', match: '\\\\.' },
              { include: '#interpolation' },
            ],
          },
          // A character literal. It did not lex once, and this rule
          // marked it invalid; the lexer grew one and the rule outlived
          // the limitation, painting correct source red.
          {
            name: 'constant.character.kflat',
            match: "'(?:[^'\\\\]|\\\\.)'",
          },
        ],
      },

      // `"a ${x} b"` expands in the lexer into the concatenation it means,
      // so a slot holds an ordinary expression.
      interpolation: {
        name: 'meta.embedded.line.kflat',
        begin: '\\$\\{',
        end: '\\}',
        beginCaptures: { 0: { name: 'punctuation.section.embedded.begin.kflat' } },
        endCaptures: { 0: { name: 'punctuation.section.embedded.end.kflat' } },
        patterns: [{ include: '#braced' }, { include: '$self' }],
      },

      // A `{ ... }` inside a slot, so its `}` does not close the slot.
      braced: {
        begin: '\\{',
        end: '\\}',
        beginCaptures: { 0: { name: 'punctuation.brackets.kflat' } },
        endCaptures: { 0: { name: 'punctuation.brackets.kflat' } },
        patterns: [{ include: '#braced' }, { include: '$self' }],
      },

      annotations: {
        name: 'storage.type.annotation.kflat',
        match: '@[A-Za-z_][A-Za-z0-9_]*',
      },

      // Painted whole so the trailing `.*` of a glob import does not read
      // as multiplication.
      imports: {
        match:
          '^\\s*(import)\\s+([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)(\\.\\*)?',
        captures: {
          1: { name: 'keyword.control.import.kflat' },
          2: { name: 'entity.name.namespace.kflat' },
          3: { name: 'keyword.operator.wildcard.kflat' },
        },
      },

      declarations: {
        patterns: [
          {
            match: '\\b(fun)\\s+([A-Za-z_][A-Za-z0-9_]*)',
            captures: {
              1: { name: 'storage.type.kflat' },
              2: { name: 'entity.name.function.kflat' },
            },
          },
          {
            match: '\\b(struct|enum|trait|impl)\\s+([A-Za-z_][A-Za-z0-9_]*)',
            captures: {
              1: { name: 'storage.type.kflat' },
              2: { name: 'entity.name.type.kflat' },
            },
          },
        ],
      },

      keywords: { patterns: keywordPatterns },

      // A name in call position. Lower-case only: an `UpperCamelCase` name
      // before `(` is an enum variant or a struct, and reads better as the
      // type it names than as the call it also is. Must follow #keywords,
      // or `when (` takes the keyword for a function.
      calls: {
        patterns: [
          {
            name: 'entity.name.function.call.kflat',
            match: '\\b[a-z_][A-Za-z0-9_]*(?=\\s*\\()',
          },
          {
            name: 'entity.name.function.call.kflat',
            match: `\\b[a-z_][A-Za-z0-9_]*(?=\\s*${GENERIC_ARGS}\\s*\\()`,
          },
        ],
      },

      // A name introduced with a type: a parameter, a struct field, a field
      // in a struct literal, an annotated binding. One rule for all four
      // because they are the same shape and colouring only some of them is
      // what looks arbitrary.
      'annotated-names': {
        name: 'variable.parameter.kflat',
        match: '\\b[a-z_][A-Za-z0-9_]*(?=\\s*:)',
      },

      // Field access. The lookahead hands `.method(` and `.method<T>(` to
      // #calls instead — without it this matches first, the `.` being the
      // earlier position, and a method reads as a field.
      properties: {
        match: `(\\.)([a-z_][A-Za-z0-9_]*)\\b(?!\\s*(?:${GENERIC_ARGS}\\s*)?\\()`,
        captures: {
          1: { name: 'punctuation.accessor.kflat' },
          2: { name: 'variable.other.property.kflat' },
        },
      },

      literals: {
        patterns: [
          // Radix, fractional and digit-grouped forms. Each of these was
          // once unlexable and marked invalid here; the lexer reads all of
          // them now, and a rule that outlives its limitation paints
          // correct source red — the failure this file exists to avoid.
          //
          // Exponents are the one part still missing, and nothing
          // here claims otherwise: `1e10` simply does not match, so it
          // reads as a number beside a name rather than as an error.
          {
            name: 'constant.numeric.integer.kflat',
            match: '\\b0[xXbBoO][0-9A-Fa-f_]+\\b',
          },
          {
            name: 'constant.numeric.float.kflat',
            match: '\\b[0-9]+\\.[0-9]+\\b',
          },
          {
            name: 'constant.numeric.integer.kflat',
            match: '\\b[0-9]+_[0-9_]*\\b',
          },
          {
            name: 'constant.numeric.integer.kflat',
            match: '\\b[0-9]+\\b',
          },
        ],
      },

      types: {
        patterns: [
          // Not a keyword — the receiver is an ordinary name the checker
          // and codegen give meaning to, and it reads better in that role.
          {
            name: 'variable.language.self.kflat',
            match: '\\bself\\b',
          },
          // Not a keyword either: `null` is a name the checker reads as the
          // empty optional, so it is a constant like `true`.
          {
            name: 'constant.language.null.kflat',
            match: '\\bnull\\b',
          },
          // `x is Variant` tests a variant; `is` is a name everywhere else,
          // so it is the operator only between an operand and a pattern.
          {
            name: 'keyword.operator.expression.is.kflat',
            match: '(?<=[\\w)\\]])\\s+\\K\\bis\\b(?=\\s+[A-Za-z_])',
          },
          {
            name: 'support.type.builtin.kflat',
            match: `\\b(?:${builtinTypes.map(esc).join('|')})\\b`,
          },
          {
            name: 'entity.name.type.kflat',
            match: '\\b[A-Z][A-Za-z0-9_]*\\b',
          },
        ],
      },

      operators: { patterns: opPatterns },
    },
  };
}

/// Every enum variant must reach a spelling, and vice versa. `op_str` and
/// `kw_str` are exhaustiveness-checked by the compiler; this catches the
/// case where the regex above stopped seeing arms it used to see.
function crossCheck(variants, arms, name) {
  const spelled = new Set(arms.map((a) => a.variant));
  const missing = variants.filter((v) => !spelled.has(v));
  if (missing.length) fail(`${name} variants with no spelling parsed: ${missing.join(', ')}`);
  const extra = arms.map((a) => a.variant).filter((v) => !variants.includes(v));
  if (extra.length) fail(`spellings for unknown ${name} variants: ${extra.join(', ')}`);
}

// --------------------------------------------------------------- main

function fail(message) {
  process.stderr.write(`generate-grammar: ${message}\n`);
  process.exit(1);
}

/// Compiling every emitted pattern here turns a malformed regex into a
/// build-time failure rather than a grammar VS Code silently discards.
function validate(grammar) {
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const key of ['match', 'begin', 'end']) {
      if (typeof node[key] === 'string') {
        try {
          new RegExp(node[key]);
        } catch (e) {
          fail(`${where}.${key} is not a valid regex: ${e.message}`);
        }
      }
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
  };
  walk(grammar.patterns, 'patterns');
  walk(grammar.repository, 'repository');
}

function main() {
  const grammar = build();
  validate(grammar);
  const text = JSON.stringify(grammar, null, 2) + '\n';

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      fail(
        `${path.relative(REPO, OUT)} is out of date with the compiler's tables. ` +
          `Run: node ${path.relative(REPO, __filename)}`
      );
    }
    process.stdout.write('grammar is up to date\n');
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  process.stdout.write(`wrote ${path.relative(REPO, OUT)}\n`);
}

main();
