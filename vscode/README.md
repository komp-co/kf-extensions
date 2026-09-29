# vscode-kflat

KFlat language support for VS Code, as a client of the KFlat language server:
the extension starts `komp lsp` and shows what it answers about `.kf` files,
`kf.toml` and `lint.toml`. Highlighting comes from a grammar generated from
the compiler's own tables, and komp's build, run, test and check are tasks.

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

It needs komp 0.6.0 or newer, and the language server, which komp installs:

```sh
komp tool install komp_lsp
```

When `komp lsp` does not start, the extension says which of the two is missing
and offers the fix: a link to installing kflat, or a task that runs
`komp tool install komp_lsp`.

To use the extension from a checkout, build it and link the folder into the
extensions directory:

```sh
cd vscode
npm install && npm run compile
ln -s "$PWD" ~/.vscode/extensions/vscode-kflat
```

To build an installable file instead:

```sh
npx @vscode/vsce package
code --install-extension vscode-kflat-0.1.0.vsix
```

To hack on it, open this directory in VS Code and press F5 for an Extension
Development Host; `npm run compile` rebuilds `dist/extension.js`.

## What the server answers

For `.kf` files: diagnostics as you type, with the compiler's fixes as quick
fixes; the outline, folding and expand-selection; hover, go-to-definition,
find-references and rename; signature help, completion, inlay hints and
semantic highlighting; Format Document through `komp fmt`; and a Run lens
above `main` and a Test lens above each `@test`, which run as komp tasks. For
`kf.toml` and `lint.toml`: package, version, toolchain and lint completion,
hover and inlay hints with each dependency's locked, allowed and newest
versions, diagnostics with a quick fix that raises a requirement, and Fetch
and Update all lenses. The server's README in
[kf-lsp](https://github.com/komp-co/kf-lsp) has the detail.

VS Code usually suggests only outside strings; in `kf.toml` and `lint.toml`
the extension turns suggestions inside strings on, so versions and levels
complete as you type them.

## Tasks

Each crate in the workspace (a directory holding a `kf.toml`) gets `komp
build`, `komp run`, `komp test` and `komp check` tasks, under **Terminal: Run
Task** → komp. Their diagnostics reach the Problems view through the `$komp`
problem matcher. In `tasks.json`:

```json
{ "type": "komp", "command": "test", "crate": "compiler/kf-parse" }
```

`crate` is relative to the workspace folder; left out, it is the folder.

## Settings and commands

| Setting | Default | |
|---|---|---|
| `kflat.kompPath` | `komp` | the komp that runs `komp lsp` and the tasks; a bare name is found on `PATH` |
| `kflat.trace.server` | `off` | log the messages between VS Code and the server in the KFlat output |

**KFlat: Restart the language server** starts `komp lsp` again, as changing
`kflat.kompPath` does.

## Highlighting

`syntaxes/kflat.tmLanguage.json` is generated from the compiler's own tables,
not written by hand:

| Read from | Gives |
|---|---|
| `kw_str` in `compiler/kf-parse/src/lexer/keyword.kf` | keyword spellings |
| `op_str` in `compiler/kf-parse/src/lexer/operator.kf` | operator spellings |
| `is_runtime_type_name` in `compiler/kf-core/src/ast/linkage.kf` | builtin type names |
| the `@lang` structs and enums under `libs/` | `String`, `List`, `Option` and the rest |

```sh
node scripts/generate-grammar.js            # rewrite the grammar
node scripts/generate-grammar.js --check    # fail if out of date
```

Adding a keyword or operator to the compiler makes the generator fail until
the new spelling is given a scope, so it cannot be silently left uncolored.
Comments, strings, numbers and the declaration rules are hand-written: they are
shapes rather than spellings. The server's semantic tokens paint over the
grammar once it answers, telling a variable from a function.

## Tests

```sh
npm install && npm test
```

Checks the grammar is current, then tokenizes with `vscode-textmate`, the
engine VS Code itself uses, so what the tests assert is what an editor paints.
The cases pin the places a regex grammar goes wrong: an operator that is a
prefix of a longer one, a run of quotes, an interpolation slot. Every `.kf`
in the komp repository goes through the grammar; that source compiles, so
anything landing in an `invalid.` scope is a false positive. The same is done
for the TOML grammar over every kf.toml, kf.lock and lint.toml, and the
`$komp` problem matcher is run over lines komp prints.

`npm run compile` type-checks the client with `tsc` and bundles it with
esbuild.
