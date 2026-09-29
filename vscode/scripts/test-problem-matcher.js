#!/usr/bin/env node
'use strict';
// The `$komp` problem matcher package.json declares, against lines komp
// prints: each must give the file, line, column, severity and message, and a
// line that is not a diagnostic must give nothing.

const pkg = require('../package.json');

const matcher = pkg.contributes.problemMatchers.find((m) => m.name === 'komp');
const pattern = matcher.pattern;
const regexp = new RegExp(pattern.regexp);

const CASES = [
  [
    '/home/me/app/src/main.kf:2:20: error: init type doesn\'t match declared',
    { file: '/home/me/app/src/main.kf', line: '2', column: '20', severity: 'error',
      message: 'init type doesn\'t match declared' },
  ],
  [
    'src/lib.kf:5:5: warning: `add_all` takes 3 parameters; the most is 2',
    { file: 'src/lib.kf', line: '5', column: '5', severity: 'warning',
      message: '`add_all` takes 3 parameters; the most is 2' },
  ],
  ['        val x: int32 = "text"', null],
  ['check: found errors', null],
  ['lint: 0 errors, 1 warning', null],
];

let failures = 0;
for (const [line, expected] of CASES) {
  const m = regexp.exec(line);
  const got = m && {
    file: m[pattern.file], line: m[pattern.line], column: m[pattern.column],
    severity: m[pattern.severity], message: m[pattern.message],
  };
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    failures++;
    process.stderr.write(`FAIL ${JSON.stringify(line)}\n     got ${JSON.stringify(got)}\n`);
  }
}
process.stdout.write(`problem matcher cases: ${CASES.length}\n`);
if (failures) process.exit(1);
process.stdout.write('ok\n');
