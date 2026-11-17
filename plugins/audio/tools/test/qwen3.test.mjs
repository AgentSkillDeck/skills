import './fixtures/native-env.mjs';
// Qwen3-TTS engine: voice forms, instruct mapping, respell lexicon, planning,
// setup, and produce/audition end to end with the fake engine standing in for
// both engine/synth.py and engine/qwen3.py (no Python, no model).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVoice, QWEN_SPEAKERS } from '../lib/voices.mjs';
import { qwenInstruct, QWEN_INSTRUCT, EMOTION_NAMES } from '../lib/presets.mjs';
import { loadLexicon, respell } from '../lib/lexicon.mjs';
import { parseScript } from '../lib/script.mjs';
import { planRender, PlanError } from '../lib/plan.mjs';
import { synthKey } from '../lib/render.mjs';
import { genderOf } from '../lib/sounds/index.mjs';
import { main as setupMain, checkQwen3Setup, QWEN3_REQUIREMENTS } from '../setup.mjs';
import { main as produceMain } from '../produce.mjs';
import { main as auditionMain } from '../audition.mjs';
import { hasFfmpeg } from '../lib/ffmpeg.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
const SKIP = (await hasFfmpeg()) ? false : 'ffmpeg not found';
const work = mkdtempSync(join(tmpdir(), 'aa qwen3 '));
after(() => rmSync(work, { recursive: true, force: true }));
const noLex = join(work, 'no-user-lexicon.json');
const ENV = { ...process.env, AGENTSKILLDECK_LEXICON: noLex };

test('qwen:<voice> parses for the nine voices and design; anything else is invalid', () => {
  assert.equal(Object.keys(QWEN_SPEAKERS).length, 9);
  assert.deepEqual(parseVoice('qwen:ryan'), { kind: 'qwen', speaker: 'ryan', voice: 'qwen:ryan' });
  assert.deepEqual(parseVoice('Qwen: Uncle-Fu'), { kind: 'qwen', speaker: 'uncle_fu', voice: 'qwen:uncle_fu' });
  assert.equal(parseVoice('qwen:design').speaker, 'design');
  assert.equal(parseVoice('qwen:morgan').kind, 'invalid');
  assert.match(parseVoice('qwen:morgan').reason, /qwen:ryan/);
  assert.match(parseVoice('X9').reason, /qwen:<voice>/);
  assert.equal(genderOf({ voice: 'qwen:ryan' }), 'male');
  assert.equal(genderOf({ voice: 'qwen:sohee' }), 'female');
  assert.equal(genderOf({ voice: 'qwen:design', gender: 'male' }), 'male');
});

test('every delivery preset has a Qwen instruction; style and modifiers compose', () => {
  for (const e of EMOTION_NAMES) assert.ok(QWEN_INSTRUCT[e], e);
  assert.equal(qwenInstruct({}), QWEN_INSTRUCT.neutral);
  assert.equal(qwenInstruct({ emotion: 'calm', modifiers: ['slow', 'bogus'], style: 'Documentary narrator.' }), `Documentary narrator. ${QWEN_INSTRUCT.calm} Take it slower than usual.`);
});

test('respell: whole terms, case-insensitive, longest first; layers merge with the script last', () => {
  const L = { git: 'ghit', '--force-with-lease': 'force with lease', 'git push': 'ghit push' };
  assert.equal(respell('Run Git push --force-with-lease; digit gitter git-lfs', L), 'Run ghit push force with lease; digit gitter git-lfs');
  assert.equal(respell('nothing here', {}), 'nothing here');
  const bundled = join(work, 'bundled.json');
  writeFileSync(bundled, JSON.stringify({ _about: 'x', terms: { sql: 'sequel', k8s: 'kates' }, qwen3: { git: 'ghit' } }));
  const user = join(work, 'user.json');
  writeFileSync(user, JSON.stringify({ k8s: 'kubernetes' }));
  const env = { AGENTSKILLDECK_LEXICON: user };
  assert.deepEqual(loadLexicon({ bundled, env }), { sql: 'sequel', k8s: 'kubernetes' });
  assert.deepEqual(loadLexicon({ bundled, env, engine: 'qwen3', meta: { lexicon: { '"SQL"': 'ess cue ell' } } }), { sql: 'ess cue ell', k8s: 'kubernetes', git: 'ghit' });
  assert.deepEqual(loadLexicon({ bundled: join(work, 'missing.json'), env: { AGENTSKILLDECK_LEXICON: join(work, 'missing2.json') } }), {});
});

const SCRIPT = `---
title: Push
preset: video
cast:
  NARRATOR: { voice: qwen:ryan, style: "Documentary narrator" }
  ANA:      { voice: qwen:design, describe: "A bright young woman, crisp accent", gender: female }
  ELI:      { voice: M3 }
lexicon:
  "--force-with-lease": force with lease
---
NARRATOR (calm, slow): Run git push --force-with-lease now.
ANA (happy): <breath> Hello there.
ELI (sad): Run git status.
`;

test('plan: Qwen lines carry instruct (no speed/gain/fx chain), design carries describe, the lexicon fills say', () => {
  const items = planRender(parseScript(SCRIPT), { env: ENV }).items;
  const [nar, anaNv, ana, eli] = items;
  assert.equal(nar.voice, 'qwen:ryan');
  assert.equal(nar.engine, 'qwen3');
  assert.equal(nar.text, 'Run git push --force-with-lease now.');
  assert.equal(nar.say, 'Run ghit push force with lease now.');
  assert.equal(nar.speed, 1);
  assert.equal(nar.gain_db, 0);
  assert.equal(nar.af, undefined);
  assert.match(nar.instruct, /^Documentary narrator\. Speak in a calm.*slower/);
  assert.equal(nar.pre_s, 0.2);
  assert.equal(anaNv.kind, 'nv');
  assert.equal(anaNv.gender, 'female');
  assert.equal(ana.describe, 'A bright young woman, crisp accent');
  // Supertonic lines keep their chain; the Qwen-only git respelling does not touch them.
  assert.equal(eli.voice, 'M3');
  assert.equal(eli.say, undefined);
  assert.equal(eli.af, 'lowpass=f=6500');
  assert.ok(eli.speed < 1);
  assert.throws(() => planRender(parseScript('---\ncast:\n  ANA: { voice: qwen:design }\n---\nANA: Hi.\n'), { env: ENV }), (e) => e instanceof PlanError && /line 5: .*describe/.test(e.message));
  assert.throws(() => planRender(parseScript('---\ncast:\n  ANA: { voice: qwen:morgan }\n---\nANA: Hi.\n'), { env: ENV }), /unknown Qwen3 voice/);
  // Qwen has no native tags: a laugh is a sample.
  const laugh = planRender(parseScript('---\ncast:\n  NARRATOR: { voice: qwen:ryan }\n---\nNARRATOR: <laugh> Fine.\n'), { env: ENV }).items;
  assert.deepEqual(laugh.map((i) => i.kind), ['nv', 'speech']);
});

test('synthKey: a Qwen take depends on instruct and describe, a Supertonic take does not change', () => {
  const engine = { mode: 'engine' };
  const base = { text: 'Hi.', voice: 'qwen:ryan', lang: 'en', seed: 0, instruct: 'a' };
  assert.notEqual(synthKey(engine, base, {}), synthKey(engine, { ...base, instruct: 'b' }, {}));
  assert.notEqual(synthKey(engine, { ...base, voice: 'qwen:design', describe: 'x' }, {}), synthKey(engine, { ...base, voice: 'qwen:design', describe: 'y' }, {}));
  assert.notEqual(synthKey(engine, base, {}), synthKey(engine, base, { AGENTSKILLDECK_QWEN3_MODEL: 'other' }));
  const st = { text: 'Hi.', voice: 'M3', lang: 'en', speed: 1, seed: 0 };
  assert.equal(synthKey(engine, st, {}), synthKey(engine, { ...st, instruct: 'ignored' }, {}));
});

function fakeHome() {
  const home = mkdtempSync(join(work, 'home '));
  return home;
}

test('setup: --install-qwen3 refuses off Apple Silicon; --check reports qwen3 as optional', async () => {
  let err = '';
  const code = await setupMain(['--install-qwen3'], { env: {}, home: fakeHome(), platform: 'linux', arch: 'x64', stdout: () => {}, stderr: (s) => { err += s; } });
  assert.equal(code, 2);
  assert.match(err, /Apple Silicon/);
  const r = await checkQwen3Setup({ env: {}, home: fakeHome(), platform: 'linux', arch: 'x64' });
  assert.deepEqual([r.optional, r.supported, r.ok, r.python], [true, false, false, null]);
  let out = '';
  await setupMain(['--check'], { env: {}, home: fakeHome(), which: () => null, probe: async () => ({}), platform: 'darwin', arch: 'arm64', stdout: (s) => { out += s; }, stderr: () => {} });
  assert.equal(JSON.parse(out).qwen3.supported, true);
  assert.equal(await setupMain(['--install-qwen3', '--bogus'], { env: {}, home: fakeHome(), stdout: () => {}, stderr: () => {} }), 1);
});

test('setup: --install-qwen3 builds its own venv, installs mlx-audio, warms the model; an existing Python skips the venv', async () => {
  const home = fakeHome();
  const hub = join(home, '.cache', 'huggingface', 'hub', 'models--mlx-community--Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit', 'snapshots', 'abc');
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === 'venv') { mkdirSync(join(args[2], 'bin'), { recursive: true }); writeFileSync(join(args[2], 'bin', 'python'), '', { mode: 0o755 }); }
  };
  const warmQwen3 = async (py, { design }) => { calls.push(['warm', py, design]); mkdirSync(hub, { recursive: true }); writeFileSync(join(hub, 'config.json'), '{}'); };
  const qwen3Probe = async () => ({ mlx_audio: '0.6.6' });
  let out = '';
  const opts = { env: {}, home, which: (n) => `/opt/bin/${n}`, run, warmQwen3, qwen3Probe, platform: 'darwin', arch: 'arm64', stdout: (s) => { out += s; }, stderr: (s) => { out += s; } };
  assert.equal(await setupMain(['--install-qwen3'], opts), 0, out);
  const venv = join(home, '.agentskilldeck', 'venv-qwen3');
  assert.deepEqual(calls[0], ['/opt/bin/python3', '-m', 'venv', venv]);
  assert.equal(calls[1].at(-1), QWEN3_REQUIREMENTS);
  assert.match(readFileSync(QWEN3_REQUIREMENTS, 'utf8'), /^mlx-audio==/);
  assert.deepEqual(calls[2], ['warm', join(venv, 'bin', 'python'), false]);
  assert.match(out, /Apache-2\.0/);
  assert.equal(JSON.parse(readFileSync(join(home, '.agentskilldeck', 'config.json'), 'utf8')).qwen3_install_ok, true);
  // AGENTSKILLDECK_QWEN3_PYTHON: no venv, no pip, weights already cached.
  calls.length = 0;
  out = '';
  const py = join(home, 'other-python');
  writeFileSync(py, '', { mode: 0o755 });
  assert.equal(await setupMain(['--install-qwen3'], { ...opts, env: { AGENTSKILLDECK_QWEN3_PYTHON: py } }), 0, out);
  assert.deepEqual(calls, [['warm', py, false]]);
  assert.match(out, /no download/);
  // --design: the VoiceDesign weights are not cached yet, so it says it downloads them.
  calls.length = 0;
  out = '';
  assert.equal(await setupMain(['--install-qwen3', '--design'], { ...opts, env: { AGENTSKILLDECK_QWEN3_PYTHON: py } }), 0, out);
  assert.deepEqual(calls, [['warm', py, true]]);
  assert.match(out, /3 GB more.*\n[\s\S]*downloads the weights/);
});

async function produce(args, { env = {}, ...ctx } = {}) {
  let out = '';
  let err = '';
  const jobs = join(work, `jobs-${Math.random().toString(36).slice(2)}.jsonl`);
  const code = await produceMain(args, {
    engine: { python: process.execPath, script: FAKE, qwen: { python: process.execPath, script: FAKE } },
    env: { ...ENV, FAKE_ENGINE_JOBS: jobs, ...env },
    stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, ...ctx,
  });
  const list = existsSync(jobs) ? readFileSync(jobs, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { code, out, err, jobs: list };
}

test('produce: a mixed Qwen/Supertonic cast renders, captions keep the written text, credits name Qwen3', { skip: SKIP }, async () => {
  const file = join(work, 'push.audio.md');
  writeFileSync(file, SCRIPT);
  const out = join(work, 'out');
  const r = await produce([file, '--out', out, '--offline', '--qa-model', 'small']);
  assert.equal(r.code, 0, r.err);
  const synth = r.jobs.filter((j) => j.mode === 'synth');
  const qwenJob = synth.find((j) => j.items.some((i) => i.speaker));
  assert.ok(qwenJob, 'one synth job went to the Qwen worker');
  assert.ok(qwenJob.items.every((i) => i.voice.startsWith('qwen:')));
  const nar = qwenJob.items.find((i) => i.speaker === 'ryan');
  assert.equal(nar.text, 'Run ghit push force with lease now.');
  assert.match(nar.instruct, /Documentary narrator/);
  assert.equal(qwenJob.items.find((i) => i.speaker === 'design').describe, 'A bright young woman, crisp accent');
  assert.ok(synth.some((j) => j.items.every((i) => i.voice === 'M3')), 'Supertonic lines went to synth.py');
  assert.ok(r.jobs.filter((j) => j.mode === 'asr').every((j) => j.model === 'small'));
  const srt = readFileSync(join(out, 'captions.srt'), 'utf8');
  assert.match(srt, /git push --force-with-lease/);
  const credits = readFileSync(join(out, 'CREDITS.md'), 'utf8');
  assert.match(credits, /Qwen3-TTS.*Apache-2\.0.*mlx-audio.*MIT/);
  assert.match(credits, /NARRATOR: the ryan voice/);
  assert.match(credits, /ANA: a designed voice/);
  assert.match(credits, /Supertonic/);
  const qa = JSON.parse(readFileSync(join(out, 'qa.json'), 'utf8'));
  const line = qa.lines.find((l) => l.speaker === 'NARRATOR');
  assert.equal(line.said, 'Run ghit push force with lease now.');
  assert.equal(line.ok, true);
  // Cached: a second run renders nothing.
  const again = await produce([file, '--out', out, '--offline', '--qa-model', 'small']);
  assert.equal(again.code, 0);
  assert.equal(again.jobs.filter((j) => j.mode === 'synth').length, 0);
  assert.equal((await produce([file, '--out', out, '--qa-model', 'large'])).code, 1);
});

test('produce: Qwen lines without the Qwen engine exit 2 with the install hint', { skip: SKIP }, async () => {
  const file = join(work, 'only-qwen.audio.md');
  writeFileSync(file, '---\ncast:\n  NARRATOR: { voice: qwen:aiden }\n---\nNARRATOR: Hi.\n');
  const r = await produce([file, '--out', join(work, 'o-missing'), '--offline'], {
    engine: undefined,
    checkSetup: async () => ({ python: '/x/python', supertonic: '1', whisper: '1' }),
    checkQwen3Setup: async () => ({ ok: false, supported: true }),
  });
  assert.equal(r.code, 2);
  assert.match(r.err, /--install-qwen3/);
  const off = await produce([file, '--out', join(work, 'o-linux'), '--offline'], {
    engine: undefined,
    checkSetup: async () => ({ python: '/x/python', supertonic: '1', whisper: '1' }),
    checkQwen3Setup: async () => ({ ok: false, supported: false }),
  });
  assert.equal(off.code, 2);
  assert.match(off.err, /Apple Silicon/);
});

test('audition: qwen voices and a designed voice, one mp3 each', { skip: SKIP }, async () => {
  const out = join(work, 'aud');
  let err = '';
  let stdout = '';
  const code = await auditionMain(['Hello there.', '--out', out, '--voices', 'qwen:ryan,M3,qwen:design', '--describe', 'A calm older woman', '--emotion', 'calm'], {
    engine: { python: process.execPath, script: FAKE, qwen: { python: process.execPath, script: FAKE } }, env: ENV,
    stdout: (s) => { stdout += s; }, stderr: (s) => { err += s; },
  });
  assert.equal(code, 0, err);
  for (const f of ['qwen-ryan.mp3', 'M3.mp3', 'qwen-design.mp3', 'audition.md']) assert.ok(existsSync(join(out, f)), f);
  assert.match(readFileSync(join(out, 'audition.md'), 'utf8'), /A calm older woman/);
  const bad = await auditionMain(['Hi', '--out', out, '--voices', 'qwen:design'], { env: ENV, stdout: () => {}, stderr: () => {} });
  assert.equal(bad, 1);
});
