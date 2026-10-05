'use strict';
// Which project a file belongs to, which server a command goes to, and the
// komp command lines the server's lenses name. Nothing here needs `vscode`,
// so scripts/test-projects.js runs it outside an editor.

const fs = require('node:fs');
const path = require('node:path');

/// The directory one language server serves `filePath` from: the outermost
/// ancestor holding a kf.toml, so a workspace's member crates share the
/// server their workspace has. The walk stops at `boundary`, the editor's
/// workspace folder, when the file is inside one. null when no kf.toml
/// encloses the file.
function projectRootFor(filePath, boundary, exists = fs.existsSync) {
  let dir = path.dirname(filePath);
  let found = null;
  for (;;) {
    if (exists(path.join(dir, 'kf.toml'))) found = dir;
    if (dir === boundary) return found;
    const parent = path.dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/// `text` as a glob matching only itself.
function globEscape(text) {
  return text.replace(/[[\]{}*?!]/g, (c) => `[${c}]`);
}

/// komp's arguments for a lens's command: `kflat.run` carries the crate's
/// directory, `kflat.test` the directory and the test's name.
function lensArguments(command, args) {
  if (command === 'kflat.run') return ['run', args[0]];
  if (command === 'kflat.test') return ['test', args[0], '--case', args[1]];
  return null;
}

/// Of the project roots `roots`, the one serving `dir`: the innermost that
/// is `dir` or holds it. null when none does.
function servingRoot(dir, roots) {
  if (typeof dir !== 'string') return null;
  const target = path.resolve(dir);
  let best = null;
  for (const root of roots) {
    const inside = target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    if (inside && (best === null || root.length > best.length)) best = root;
  }
  return best;
}

module.exports = { projectRootFor, globEscape, lensArguments, servingRoot };
