'use strict';
// Runs the Python unittest suite (test_vad.py) for the Mac client's VAD and target switch.
// Prints SKIP when no python interpreter is on PATH (the tests still ship; see modules/voice/README.md).
const { spawnSync } = require('child_process');
const path = require('path');
const file = path.join(__dirname, 'test_vad.py');
for (const exe of ['python3', 'python']) {
  const v = spawnSync(exe, ['-c', 'import sys; print(sys.version_info >= (3, 8))'], { encoding: 'utf8' });
  if (v.status !== 0 || v.stdout.trim() !== 'True') continue;
  const r = spawnSync(exe, ['-I', file], { encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/Ran (\d+) tests?/);
  console.log(`result: ${r.status === 0 ? 'ok' : 'FAILED'}${m ? ' (' + m[1] + ' tests via ' + exe + ')' : ''}`);
  if (r.status !== 0) console.log(out);
  process.exit(r.status === 0 ? 0 : 1);
}
console.log('SKIP: python 3.8+ not on PATH; run python modules/voice/test/test_vad.py where it is');
