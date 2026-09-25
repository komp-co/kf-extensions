# kf-extensions

Editor extensions for [KFlat](https://github.com/komp-co/komp).

| Directory | Editor |
|---|---|
| [`vscode/`](vscode/) | Visual Studio Code: highlighting, diagnostics, and hover, completion, rename and the rest through `komp query` |

The highlighting grammar is generated from the compiler's own lexer tables, so
the generator reads a komp checkout: `komp` beside this repository, or the one
`KOMP_REPO` names. For Neovim and other LSP clients, see
[kf-lsp](https://github.com/komp-co/kf-lsp).
