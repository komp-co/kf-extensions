#!/usr/bin/env node
'use strict';
// The staleness rule from stale.js, against real files and a real git
// repository — this repository.
//
//   npm install && npm test
//
// The rule decides something on its own rather than relaying what komp said,
// so it can be wrong on its own. The case that matters most is the quiet one:
// `git checkout` rewrites the mtime of every file it touches, so a naive
// mtime comparison calls a current binary stale after every branch switch.
// A warning that cries wolf is one nobody reads, so that case is pinned here.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stale = require('../stale');

// A komp checkout: `KOMP_REPO`, or `komp` beside this kf-extensions checkout.
const REPO = process.env.KOMP_REPO || path.resolve(__dirname, '..', '..', '..', 'komp');

let failures = 0;
function report(name, detail) {
  process.stderr.write(`FAIL  ${name}\n      ${detail}\n`);
  failures += 1;
}
function check(name, got, want) {
  if (got === want) process.stdout.write(`  ok  ${name}\n`);
  else report(name, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------- describeAge

check('a gap under an hour reads in minutes', stale.describeAge(25 * 60000), '25 minutes');
check('a sub-minute gap does not read as zero', stale.describeAge(400), '1 minute');
check('one minute is singular', stale.describeAge(60000), '1 minute');
check('an hour and a half reads in hours', stale.describeAge(90 * 60000), '1 hour');
check('two days reads in days', stale.describeAge(48 * 3600000), '2 days');

// -------------------------------------------------------------- resolveBinary

check(
  'a path is taken as written',
  stale.resolveBinary(path.join(REPO, 'bootstrap', 'build.sh')),
  path.join(REPO, 'bootstrap', 'build.sh')
);
check('a bare name that is on no PATH resolves to nothing',
  stale.resolveBinary('definitely-not-a-real-binary-xyzzy'), null);

// -------------------------------------------------------------- kompTreeAbove

check(
  'a binary in bin/ finds the checkout above it',
  stale.kompTreeAbove(path.join(REPO, 'bin', 'komp')),
  REPO
);
check('a binary outside any checkout finds none', stale.kompTreeAbove('/usr/bin/komp'), null);

// --------------------------------------------------------------- newestMtimeOf

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kflat-stale-'));
  fs.writeFileSync(path.join(dir, 'edited.kf'), 'x');
  fs.utimesSync(path.join(dir, 'edited.kf'), new Date(5e11), new Date(5e11));

  check(
    'a modified path is timed',
    stale.newestMtimeOf(dir, ' M edited.kf\n'),
    5e11
  );
  check(
    'a rename is timed by its new name',
    stale.newestMtimeOf(dir, 'R  gone.kf -> edited.kf\n'),
    5e11
  );
  check(
    'a path that is no longer there times nothing',
    stale.newestMtimeOf(dir, ' D vanished.kf\n'),
    0
  );
  check('empty output times nothing', stale.newestMtimeOf(dir, ''), 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ----------------------------------------------------------------- stalenessOf

const probes = [];
function probe(name, mtime) {
  const at = path.join(REPO, 'bin', name);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, '');
  fs.chmodSync(at, 0o755);
  fs.utimesSync(at, mtime, mtime);
  probes.push(at);
  return at;
}

// The commit timestamp this is all compared against.
const lastCommit =
  Number(
    execFileSync('git', ['-C', REPO, 'log', '-1', '--format=%ct', '--', 'compiler'], {
      encoding: 'utf8',
    }).trim()
  ) * 1000;

const ancient = probe('komp_probe_ancient', new Date(lastCommit - 3 * 86400000));
const fresh = probe('komp_probe_fresh', new Date(Date.now() + 60000));

// A tree whose committed sources are all older than the binary, but whose
// files were just written — what a checkout leaves behind. The mtimes say
// "stale" and the rule has to say otherwise.
const checkoutLike = fs.mkdtempSync(path.join(os.tmpdir(), 'kflat-checkout-'));
fs.mkdirSync(path.join(checkoutLike, 'compiler', 'komp'), { recursive: true });
fs.writeFileSync(path.join(checkoutLike, 'compiler', 'komp', 'kf.toml'), '');
fs.writeFileSync(path.join(checkoutLike, 'compiler', 'komp', 'main.kf'), 'fun main(): int32 { return 0 }');
fs.mkdirSync(path.join(checkoutLike, 'bin'));
const afterCheckout = path.join(checkoutLike, 'bin', 'komp');
fs.writeFileSync(afterCheckout, '');
fs.chmodSync(afterCheckout, 0o755);

function commitCheckoutLike() {
  const git = (...args) => execFileSync('git', ['-C', checkoutLike, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('add', '-A');
  execFileSync('git', ['-C', checkoutLike, 'commit', '-q', '-m', 'sources'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  });
  // Now do what a checkout does: leave the source newer than the binary
  // while the commit behind it stays old.
  const built = new Date(Date.now() - 3600000);
  fs.utimesSync(afterCheckout, built, built);
  const touched = new Date();
  fs.utimesSync(path.join(checkoutLike, 'compiler', 'komp', 'main.kf'), touched, touched);
}
commitCheckoutLike();

const pending = [
  ['a binary older than the last compiler commit is stale', ancient, true],
  ['a binary newer than every source is current', fresh, false],
  ['a binary outside a checkout is never stale', process.execPath, false],
  ['a source mtime bumped by a checkout does not make a binary stale', afterCheckout, false],
];

function drain(index) {
  if (index >= pending.length) return finish();
  const [name, binary, wantStale] = pending[index];
  stale.stalenessOf(binary, (result) => {
    check(name, result !== null, wantStale);
    drain(index + 1);
  });
}

function finish() {
  for (const p of probes) fs.rmSync(p, { force: true });
  fs.rmSync(checkoutLike, { recursive: true, force: true });
  if (failures) {
    process.stderr.write(`\n${failures} failure${failures === 1 ? '' : 's'}\n`);
    process.exit(1);
  }
  process.stdout.write('ok\n');
}

drain(0);
