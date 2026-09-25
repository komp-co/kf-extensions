'use strict';
// Deciding whether the configured komp predates the compiler it came from.
//
// Split out of extension.js because it is the one thing here that reaches a
// conclusion of its own rather than relaying what komp said, and because
// nothing in it needs `vscode` -- which is what lets scripts/test-staleness.js
// run it outside an editor.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/// What `execFile` will run, as a path. A bare name is looked up the way it
/// would look it up, because the file has to be stat-ed to be judged.
function resolveBinary(bin) {
  if (bin.includes(path.sep)) return path.resolve(bin);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep walking PATH.
    }
  }
  return null;
}

/// The binary as `{ path, builtMs }`, resolved through symlinks --
/// `~/.local/bin/komp -> <checkout>/.build/komp` is a normal way to have it on
/// PATH, and the checkout is what the rest of this needs to find.
///
/// null when there is nothing to stat: missing entirely is a louder failure
/// that the caller reports on its own.
function binaryStamp(kompPath) {
  const resolved = resolveBinary(kompPath);
  if (!resolved) return null;
  try {
    const real = fs.realpathSync(resolved);
    return { path: real, builtMs: fs.statSync(real).mtimeMs };
  } catch {
    return null;
  }
}

/// The checkout a binary was built from: the nearest ancestor holding the
/// compiler's own crate. `.build/komp` puts it one level up, but nothing here
/// depends on that. null for a komp installed from anywhere else, which has
/// no tree to be behind.
function kompTreeAbove(binaryPath) {
  let dir = path.dirname(binaryPath);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'compiler', 'komp', 'kf.toml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/// When the compiler last changed, in epoch ms.
///
/// mtime alone cannot answer this. `git checkout` rewrites the mtime of every
/// file it touches, so switching branches makes a perfectly current binary
/// look older than sources it already contains -- and a warning that fires
/// after every branch switch is one nobody reads. What a checkout does not
/// move is the commit timestamp, so that is the signal, topped up with the
/// mtimes of whatever is modified but not yet committed.
///
/// Outside git there is nothing better than the mtimes, so fall back to them.
function newestCompilerChange(tree, done) {
  const compilerDir = path.join(tree, 'compiler');
  execFile(
    'git', ['-C', tree, 'log', '-1', '--format=%ct', '--', 'compiler'],
    { timeout: 5000 },
    (error, stdout) => {
      const committed = Number(String(stdout).trim()) * 1000;
      if (error || !Number.isFinite(committed) || committed <= 0) {
        return done(newestMtimeUnder(compilerDir));
      }
      execFile(
        'git', ['-C', tree, 'status', '--porcelain', '--', 'compiler'],
        { timeout: 5000 },
        (statusError, statusOut) => {
          if (statusError) return done(committed);
          done(Math.max(committed, newestMtimeOf(tree, String(statusOut))));
        }
      );
    }
  );
}

/// The newest mtime among the paths `git status --porcelain` named. These are
/// the files a commit timestamp cannot speak for.
function newestMtimeOf(tree, statusOutput) {
  let newest = 0;
  for (const line of statusOutput.split('\n')) {
    // `XY path`, and `XY old -> new` for a rename: the new name is the one
    // on disk to be timed.
    const entry = line.slice(3).trim();
    if (!entry) continue;
    const renamed = entry.split(' -> ');
    const rel = renamed[renamed.length - 1].replace(/^"|"$/g, '');
    try {
      const at = fs.statSync(path.join(tree, rel)).mtimeMs;
      if (at > newest) newest = at;
    } catch {
      // Deleted, or a quoted path this does not unescape. Nothing to time
      // either way, and the commit timestamp still stands.
    }
  }
  return newest;
}

function newestMtimeUnder(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Build output is written BY the binary being judged, so it is always
      // newer than it and would make every binary look stale.
      if (entry.name === 'target' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith('.kf')) {
        try {
          const at = fs.statSync(full).mtimeMs;
          if (at > newest) newest = at;
        } catch {
          // Vanished mid-walk; nothing to compare.
        }
      }
    }
  }
  return newest;
}

/// A gap in ms as the coarsest unit that still says something. "3 days" is
/// what makes someone rebuild; "4691 minutes" is not.
function describeAge(ms) {
  // Round a sub-minute gap up rather than down: "0 minutes older" reads as a
  // bug in the warning rather than as a fresh binary.
  const minutes = Math.max(Math.floor(ms / 60000), 1);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.floor(hours / 24)} days`;
}

/// `done({ binary, tree, behindMs })` when the binary predates the newest
/// change to the checkout it came from, and `done(null)` for every other
/// case -- current, not in a checkout, or not there at all.
function stalenessOf(kompPath, done) {
  const stamp = binaryStamp(kompPath);
  if (!stamp) return done(null);
  const tree = kompTreeAbove(stamp.path);
  if (!tree) return done(null);
  newestCompilerChange(tree, (newest) => {
    if (!newest || stamp.builtMs >= newest) return done(null);
    done({ binary: stamp.path, tree, behindMs: newest - stamp.builtMs });
  });
}

module.exports = {
  binaryStamp,
  describeAge,
  kompTreeAbove,
  newestCompilerChange,
  newestMtimeOf,
  newestMtimeUnder,
  resolveBinary,
  stalenessOf,
};
