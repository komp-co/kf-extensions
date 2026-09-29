# vscode-kflat

KFlat language support for VS Code: highlighting for `.kf`, diagnostics from
`komp check`, and an outline, folding ranges, hover, inlay hints,
expand-selection, signature help, completion, rename, go-to-definition,
find-references and semantic highlighting from `komp query`. No runtime
dependencies.

## File icons

| File | Icon | Language id |
|---|---|---|
| `*.kf` | the folded K | `kflat` |
| `*_test.kf` | the K with a check | `kflat-test` |
| `kf.toml` | the paper kiwi | `kflat-manifest` |
| `kf.lock` | the kiwi with a lock | `kflat-lock` |
| `lint.toml` | the kiwi with a list | `kflat-lints` |

VS Code gives an icon per language, so a test file and each of komp's files
is a language of its own; the test language shares the KFlat grammar and
every editor feature. The default Seti icon theme and the minimal theme show
these icons; a theme with its own table shows its own. The three komp files
are highlighted by the TOML grammar in `syntaxes/kflat-toml.tmLanguage.json`,
which takes precedence over another extension's TOML support for those three
names only.

## Install

The extension is a plain folder, so linking it into the extensions directory
is enough — no packaging, no network:

```sh
ln -s "$PWD/vscode" ~/.vscode/extensions/vscode-kflat   # from a kf-extensions checkout
```

Restart VS Code. Changes to `extension.js` need another restart; changes to
the grammar take effect on reload.

To build an installable file instead:

```sh
cd vscode
npx @vscode/vsce package
code --install-extension vscode-kflat-0.1.0.vsix
```

To hack on it, open this directory in VS Code and press F5 for an Extension
Development Host.

If `komp` is not on `PATH`, set `kflat.kompPath` to your binary. Prefer one
inside a komp checkout (`.build/komp`, which `scripts/refresh-komp.sh` writes;
`bin/komp` is a symlink to it) — the stdlib sysroot resolves through
`<binary>/../libs`, so a compiler built elsewhere only finds the libraries
when the working directory happens to be the repository root.

## Settings

| Setting | Default | |
|---|---|---|
| `kflat.kompPath` | `komp` | path to the compiler |
| `kflat.checkOnSave` | `true` | check the crate on save |
| `kflat.checkOnOpen` | `true` | check the crate on open |
| `kflat.checkTimeoutMs` | `60000` | kill a check that runs longer |
| `kflat.queryTimeoutMs` | `30000` | kill a query that runs longer |
| `kflat.warnOnStaleBinary` | `true` | warn when the binary predates its own checkout |

## How it works

**Diagnostics.** On open and save, `komp check --format=json` runs
on the file's crate — the nearest ancestor holding a `kf.toml` — and its
newline-delimited JSON is republished as VS Code diagnostics. The extension
never parses `.kf`; the compiler decides what is an error. One check runs per
crate at a time, and a save during a running check queues exactly one re-run.

komp reports byte offsets and VS Code counts UTF-16 code units, so the two
only agree on an all-ASCII line; the extension converts.

**A stale compiler.** Every feature here is the configured binary's opinion.
An old one answers with an old compiler's semantics, and a wrong answer looks
exactly like a right one — so the extension says once per build when the
binary predates the checkout it came from.

`scripts/refresh-komp.sh` now writes `.build/komp` and points `bin/komp` at
it, so the documented paths are one file and cannot drift apart. They did:
`bin/komp` went unwritten for weeks while `.build/komp` moved, and the
symptom was the editor reporting a name the compiler had recently gained as
missing — which dates the binary rather than describing the code.

It is deliberately not an mtime comparison. `git checkout` rewrites the mtime
of every file it touches, so comparing against source mtimes calls a current
binary stale after every branch switch, and a warning that cries wolf is one
nobody reads. The signal is the last *commit* to touch `compiler/`, which a
checkout does not move, topped up with the mtimes of whatever `git status`
reports as modified. Outside git it falls back to mtimes, having nothing
better. A komp installed from somewhere else has no checkout to be behind and
is never reported.

**Outline and folding.** The breadcrumb bar, the outline view, "go to symbol
in file" and the fold gutter all come from `komp query symbols` and `komp
query folding` over the one file being edited. Those queries only parse, so
they keep answering while the file does not type-check — which is most of the
time while typing.

A declaration's outline entry covers the whole declaration, because komp does
not yet record where a name token sits inside it; clicking an entry therefore
selects the declaration rather than just its name.

**Hover and inlay hints.** Both report a type, so both run `komp query` over
the file's crate rather than the file alone — a type is what the checker
says it is, and the checker needs the imports. That makes them cost about
what a `komp check` costs.

**Every answer is about the buffer.** An unsaved buffer is written to a
temporary file and handed to komp as `--overlay`, while `--file` stays the
document's own path. komp then finds the file in its crate as usual and
parses the staged text in its place, so a position means what it means on
screen. Typed answers used to describe the last saved state, which put
completion — asked, by definition, while the buffer is dirty — at an offset
into text the author was no longer looking at.

Hover answers about the innermost expression covering the cursor. Inlay
hints appear after every `val` and `var` written without a type.

**Signature help.** Typing `(` or `,` inside a call shows the callee's
parameters with the one being typed highlighted. The parameter names come
from the declaration, so they are the names its author chose.

**Completion.** Typing `.` after a receiver offers its fields and instance
methods, with each one's type or signature. The members come from the
crate's declarations, so a dependency's type completes as readily as one of
your own. `static fun`s are left out — they take no receiver.

**Rename.** F2 on a declaration or any use of it rewrites all of them, sibling
files included. It refuses — with the reason — when the new name is already
taken in the crate, is not an identifier, or when the declaration lives in a
dependency, where renaming it from here would edit somebody else's source.

**Quick fixes.** A diagnostic that carries a repair offers it as a code
action. `no method \`sunm\` on \`Point\`` suggests `sum` and replaces exactly
those four characters; `cannot find function \`println\`` offers to add
`import core.*` at the top of the file. The compiler says which bytes, so
the editor does not have to guess — and the action is offered where the
problem is, even when the edit lands elsewhere.

**Semantic highlighting.** The TextMate grammar paints instantly and
offline but only matches spellings — every `UpperCamelCase` word reads as a
type, and a variable is not told apart from a function. `komp query tokens`
corrects it once the crate has been checked, colouring each name by what it
actually is.

**Go to definition and find references.** F12 and Shift+F12 read one
answer: the declaration the cursor names, and every use of it in the crate,
sibling files included. Top-level declarations only — a parameter or a
local answers with nothing, because the resolver stamps only top-level
names.

**Expand selection.** Shift+Alt+Right grows through the chain of spans
around the cursor: the expression, whatever encloses it, then the whole
declaration. That one parses rather than checks, so it stays instant and
works on an unsaved buffer.

**Highlighting.** `syntaxes/kflat.tmLanguage.json` is generated from the
compiler's own tables, not written by hand:

| Read from | Gives |
|---|---|
| `kw_str` in `compiler/kf-parse/src/lexer/keyword.kf` | keyword spellings |
| `op_str` in `compiler/kf-parse/src/lexer/operator.kf` | operator spellings |
| `is_runtime_type_name` in `compiler/kf-core/src/ast/linkage.kf` | builtin type names |

```sh
node scripts/generate-grammar.js            # rewrite the grammar
node scripts/generate-grammar.js --check    # fail if out of date
```

Adding a keyword or operator to the compiler makes the generator fail until
the new spelling is given a scope, so it cannot be silently left uncolored.

Comments, strings, numbers and the declaration rules are hand-written — they
are shapes rather than spellings.

## Tests

```sh
npm install && npm test
```

Checks the grammar is current, then tokenizes with `vscode-textmate` — the
engine VS Code itself uses, so what the tests assert is what an editor paints.
The cases pin the places a regex grammar goes wrong: an operator that is a
prefix of a longer one, a run of quotes, an interpolation slot. Then every
`.kf` in the repository goes through the grammar; that source compiles, so
anything landing in an `invalid.` scope is a false positive.

The tokenizer is a dev dependency. The extension itself needs nothing.

## Limits

Highlighting is lexical. Every `UpperCamelCase` word reads as a type, and a
variable is not told apart from a function, because a regex grammar cannot
know what a name means. Diagnostics arrive on save, for a whole crate at a
time, at the cost of a process launch.

Both limits have the same fix: a KFlat-native language server that imports
`kf_parse` and `kf_typecheck` in-process rather than shelling out, the way
rust-analyzer links `rustc_lexer` instead of running `rustc` (#83).
