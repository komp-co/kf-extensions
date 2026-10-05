#!/usr/bin/env node
'use strict';
// projects.js against made-up trees: which directory a file's language
// server runs in, and the komp commands behind the Run and Test lenses.

const path = require('node:path');
const projects = require('../projects');

let failures = 0;
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    process.stdout.write(`  ok  ${name}\n`);
  } else {
    process.stderr.write(`FAIL  ${name}\n      got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}\n`);
    failures += 1;
  }
}

/// An `exists` that sees a kf.toml in each of `dirs` and nothing else.
const manifestsIn = (...dirs) => (file) => dirs.some((d) => path.join(d, 'kf.toml') === file);

check(
  'a crate is its own project',
  projects.projectRootFor('/w/app/src/main.kf', null, manifestsIn('/w/app')),
  '/w/app'
);
check(
  'a member crate is served from its workspace',
  projects.projectRootFor('/w/compiler/kf-core/src/a.kf', null, manifestsIn('/w/compiler', '/w/compiler/kf-core')),
  '/w/compiler'
);
check(
  'the walk stops at the workspace folder',
  projects.projectRootFor('/w/app/src/main.kf', '/w/app', manifestsIn('/w', '/w/app')),
  '/w/app'
);
check(
  'a file under no kf.toml has no project',
  projects.projectRootFor('/w/notes/a.kf', null, manifestsIn('/w/app')),
  null
);
check(
  "a manifest's own directory is its project",
  projects.projectRootFor('/w/app/kf.toml', null, manifestsIn('/w/app')),
  '/w/app'
);

check('a plain path is its own glob', projects.globEscape('/home/me/app'), '/home/me/app');
check('glob characters match only themselves', projects.globEscape('/a[1]/{b}*?'), '/a[[]1[]]/[{]b[}][*][?]');

check('a Run lens runs the crate', projects.lensArguments('kflat.run', ['/w/app']), ['run', '/w/app']);
check(
  'a Test lens runs one test',
  projects.lensArguments('kflat.test', ['/w/app', 'adds']),
  ['test', '/w/app', '--case', 'adds']
);
check('another command is not a lens', projects.lensArguments('komp.fetch', ['/w/app']), null);

check('a command for a crate goes to its project', projects.servingRoot('/w/app', ['/w/app', '/w/lib']), '/w/app');
check(
  "a member crate's command goes to its workspace",
  projects.servingRoot('/w/compiler/kf-core', ['/w/compiler', '/w/app']),
  '/w/compiler'
);
check('the innermost serving project wins', projects.servingRoot('/w/a/b', ['/w', '/w/a']), '/w/a');
check('a sibling with a common prefix does not serve', projects.servingRoot('/w/app2', ['/w/app']), null);
check('a command without a directory goes nowhere', projects.servingRoot(undefined, ['/w/app']), null);

if (failures > 0) {
  process.stderr.write(`${failures} failed\n`);
  process.exit(1);
}
