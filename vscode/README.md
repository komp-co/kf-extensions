# vscode-kflat

KFlat language support for VS Code: highlighting for `.kf`, file icons, and
every editor feature from the KFlat language server, `komp lsp`:
diagnostics as you type, quick fixes, the outline, folding, expand-selection,
hover, inlay hints, signature help, completion, go-to-definition,
go-to-implementation, find-references, rename, semantic highlighting,
formatting, Run and Test lenses, and the same for `kf.toml` and `lint.toml`,
where Fetch and Update lenses sit above `[dependencies]`.

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

The extension starts the language server through komp, so install that once:

```sh
komp tool install komp_lsp
```

Then build an installable file:

```sh
cd vscode
npm install
npx @vscode/vsce package
code --install-extension vscode-kflat-0.2.0.vsix
```

Or link the folder into the extensions directory, after `npm install
--omit=dev` has fetched the language client it runs on:

```sh
cd vscode && npm install --omit=dev
ln -s "$PWD" ~/.vscode/extensions/vscode-kflat
```

Restart VS Code. To hack on it, open this directory in VS Code and press F5
for an Extension Development Host.

If `komp` is not on `PATH`, set `kflat.kompPath` to your binary. When the
server does not start, the extension says so and offers to run `komp tool
install komp_lsp`; what the server printed is in the KFlat output.

## Settings

| Setting | Default | |
|---|---|---|
| `kflat.kompPath` | `komp` | the komp that starts the server |
| `kflat.warnOnStaleBinary` | `true` | warn when the binary predates its own checkout |
| `kflat.trace.server` | `off` | log the server's messages to the KFlat output |

**KFlat: Restart the language server** stops every server and starts them
again; changing `kflat.kompPath` does the same.

## How it works

**One server per project.** Opening a `.kf`, `kf.toml` or `lint.toml` file
starts `komp lsp` in its project: the outermost directory above it holding a
`kf.toml`, without leaving the workspace folder. A workspace's member crates
therefore share their workspace's server, which checks a crate together with
the crates that depend on it. komp runs the server version the project pins
in `[tools]`, else the installed one. The extension never parses KFlat; every
answer is the server's, and the server's are the compiler's, about the text on
screen rather than the file as last saved.

**Run and Test lenses.** The extension tells the server it runs
`kflat.run` and `kflat.test`, so a Run lens sits above `fun main` and a Test
lens above each `@test` function. Each runs `komp run` or `komp test --case`
as a task.

**kf.toml's lenses.** Fetch and Update run `komp metadata` and `komp update`
in the server, which says when they finish. Their commands are registered
once for every server, since VS Code refuses a command name twice, and each
click goes to the server of the project holding the crate.

**Semantic highlighting.** The server's tokens tell a type from an enum
variant, a field and a method, which the grammar cannot. KFlat files turn
`editor.semanticHighlighting.enabled` on, so they show under a theme that
leaves it off; set it back per language to prefer the theme's choice.

**A stale compiler.** Every answer is the configured binary's opinion. An
old one answers with an old compiler's semantics, and a wrong answer looks
exactly like a right one, so the extension says once per build when the
binary predates the checkout it came from. The signal is the last *commit*
to touch `compiler/`, topped up with the mtimes of what `git status` reports
as modified, since `git checkout` rewrites the mtime of every file it
touches. A komp installed from somewhere else is never reported.

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

Checks the grammar is current, then tokenizes with `vscode-textmate`, the
engine VS Code itself uses, so what the tests assert is what an editor paints.
The cases pin the places a regex grammar goes wrong: an operator that is a
prefix of a longer one, a run of quotes, an interpolation slot. Then every
`.kf` in the repository goes through the grammar; that source compiles, so
anything landing in an `invalid.` scope is a false positive. The staleness
rule and the choice of a file's project run outside an editor.

```sh
npm run test-editor
```

Starts an editor with the extension loaded and `test/fixture` open, and asks
it what a user would see: hover, definition, implementation, references, the
outline, completion, inlay hints, formatting, the Run lens and the task it
runs, kf.toml's lenses in two projects at once, and a diagnostic for an
unsaved edit. It needs komp with the language server installed
(`KOMP_BIN` names a komp off `PATH`); `CODE_BIN` names the editor, else a VS
Code is downloaded. Without a display, run it under `xvfb-run -a`.

## Limits

The grammar's colouring is lexical: every `UpperCamelCase` word reads as a
type until the server's semantic tokens arrive. Everything else is as good as
the server's answers; the KFlat book's editor chapter lists what they do not
reach yet.
