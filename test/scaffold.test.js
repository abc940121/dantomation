#!/usr/bin/env node
'use strict';
// Tests modules/scaffold/scaffold.js (taskmote new-module). Everything is generated into a temp
// modules dir; the real modules/ is never written. The temp tree gets a junction to the
// real lib/ so the generated suite can require ../../lib/modules like a real module does.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('../modules/scaffold/scaffold');
const M = require('../lib/modules');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-scaffold-'));
const modulesDir = path.join(tmp, 'modules');
fs.mkdirSync(modulesDir);
fs.symlinkSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), 'junction');

let fails = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + String(info).slice(0, 300)}`); if (!ok) fails++; };
const throws = (f) => { try { f(); return null; } catch (e) { return e.message; } };

const skillDir = path.join(tmp, 'src', 'my-skill');
fs.mkdirSync(path.join(skillDir, 'refs'), { recursive: true });
const BODY = '# Do the thing\n\nStep one.\nStep two.\n';
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: my-skill\ndescription: >\n  Does the thing\n  well.\n---\n\n${BODY}`);
fs.writeFileSync(path.join(skillDir, 'refs', 'notes.md'), 'extra\n');

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

try {
  const r = S.newModule('my-mod', { fromSkill: skillDir, modulesDir });
  const dir = path.join(modulesDir, 'my-mod');
  check('files generated', ['index.js', 'tests.json', 'test/run.js', 'DECISIONS.md', 'PROVENANCE.md', 'skill.md', 'files/refs/notes.md'].every(f => r.files.includes(f)), r.files);
  const m = require(path.join(dir, 'index.js'));
  check('manifest validates (lib/modules.validate)', throws(() => M.validate(m, 'my-mod', dir)) === null);
  check('contract is 2, name, description from frontmatter', m.contract === 2 && m.name === 'my-mod' && m.description === 'Does the thing well.', m.description);
  check('skill.md is the body without frontmatter', fs.readFileSync(path.join(dir, 'skill.md'), 'utf8') === BODY);
  check('body not inlined in index.js', !fs.readFileSync(path.join(dir, 'index.js'), 'utf8').includes('Step one'));
  check('DECISIONS names the skill', /generated from skill my-skill/.test(fs.readFileSync(path.join(dir, 'DECISIONS.md'), 'utf8')));
  const prov = fs.readFileSync(path.join(dir, 'PROVENANCE.md'), 'utf8');
  check('PROVENANCE: folder name only, license unknown', prov.includes('"my-skill"') && prov.includes('license: unknown, check before publishing') && !prov.includes(skillDir), prov);
  const tj = JSON.parse(fs.readFileSync(path.join(dir, 'tests.json'), 'utf8'));
  check('tests.json lists the generated suite', tj.suites.length === 1 && tj.suites[0].file === 'test/run.js' && fs.existsSync(path.join(dir, tj.suites[0].file)));
  const run = spawnSync(process.execPath, [path.join(dir, 'test', 'run.js')], { encoding: 'utf8', env: { ...process.env, HARNESS_CONFIG: path.join(tmp, 'none.json') } });
  check('generated suite passes', run.status === 0 && !/^FAIL/m.test(run.stdout), run.stdout + run.stderr);
  check('off by default: not in the shipped defaults', !('my-mod' in require('../lib/config').DEFAULTS.modules));

  // no absolute path, user name or machine name in the generated files (extras are the skill's own content)
  const needles = [tmp, ROOT, os.homedir(), os.hostname(), os.userInfo().username].filter(s => s && s.length > 2);
  const bad = [];
  for (const f of walk(dir)) {
    if (f.includes(path.join(dir, 'files'))) continue;
    const t = fs.readFileSync(f, 'utf8');
    if (needles.some(n => t.includes(n)) || /[A-Za-z]:[\/]/.test(t) || /\/(Users|home)\//.test(t)) bad.push(path.relative(dir, f));
  }
  check('no absolute path, user or machine name in output', bad.length === 0, bad);

  check('bad names refused', ['A', 'a', '1abc', 'has_underscore', '../x', 'x/y', 'x'.repeat(42), '', 'Bad'].every(n => throws(() => S.newModule(n, { modulesDir })) !== null));
  check('nothing written outside modules/<name>', fs.readdirSync(modulesDir).join() === 'my-mod' && !fs.existsSync(path.join(tmp, 'x')));
  const ex = throws(() => S.newModule('my-mod', { fromSkill: skillDir, modulesDir }));
  check('existing dir refused without --force', /already exists/.test(ex || ''), ex);
  fs.writeFileSync(path.join(dir, 'stale.txt'), 's');
  check('--force overwrites', throws(() => S.newModule('my-mod', { fromSkill: skillDir, modulesDir, force: true })) === null && !fs.existsSync(path.join(dir, 'stale.txt')));

  const nf = path.join(tmp, 'src', 'plain'); fs.mkdirSync(nf);
  fs.writeFileSync(path.join(nf, 'SKILL.md'), '# just markdown\n');
  const e1 = throws(() => S.newModule('plain-mod', { fromSkill: nf, modulesDir }));
  check('no frontmatter: clear error, nothing written', /no YAML frontmatter/.test(e1 || '') && !fs.existsSync(path.join(modulesDir, 'plain-mod')), e1);
  fs.writeFileSync(path.join(nf, 'SKILL.md'), '---\nname: x\n---\nbody\n');
  check('missing description: clear error', /no "description"/.test(throws(() => S.newModule('plain-mod', { fromSkill: nf, modulesDir })) || ''));
  check('missing SKILL.md: clear error', /no SKILL\.md/.test(throws(() => S.newModule('plain-mod', { fromSkill: path.join(tmp, 'nope'), modulesDir })) || ''));

  S.newModule('bare-mod', { modulesDir });
  const bd = path.join(modulesDir, 'bare-mod');
  const bm = require(path.join(bd, 'index.js'));
  check('without a skill: validates, contract 2', throws(() => M.validate(bm, 'bare-mod', bd)) === null && bm.contract === 2);
  const br = spawnSync(process.execPath, [path.join(bd, 'test', 'run.js')], { encoding: 'utf8', env: { ...process.env, HARNESS_CONFIG: path.join(tmp, 'none.json') } });
  check('without a skill: generated suite passes', br.status === 0, br.stdout + br.stderr);

  const cliErr = throws(() => S.cli([]));
  check('cli: no name -> usage', /usage/.test(cliErr || ''), cliErr);
} catch (e) { check('suite ran', false, e && e.stack || e); }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`result: ${fails ? fails + ' failing' : 'all passed'}`);
process.exit(fails ? 1 : 0);
