import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runVideoTextCommand } from './video-text-command.js';
import { compileVideoTextAss, parseVideoTextPlan } from './video-text.js';

const base = () => ({
  schemaVersion: 1,
  width: 720,
  height: 1280,
  captions: [{ start: 0.4, end: 1.9, text: 'Hey, what are those' }],
  overlays: [{ start: 0, end: 2.1, text: 'A hook\nSecond line' }],
});
test('one plan compiles independent caption and overlay placement without rewriting source text', () => {
  const input = base(),
    saved = structuredClone(input);
  const { plan, ass } = compileVideoTextAss(input);
  assert.deepEqual(input, saved);
  assert.equal(plan.captionStyle.fontSize, 36);
  assert.equal(plan.captionStyle.marginVertical, 300);
  assert.equal(plan.overlays[0]!.style.fontSize, 43);
  assert.equal(plan.overlays[0]!.style.marginVertical, 95);
  assert.ok(
    ass.includes('0:00:00.40,0:00:01.90,Caption,,0,0,0,,Hey, what are those'),
  );
  assert.ok(ass.includes('A hook\\NSecond line'));
});
test('timed overlaps and explicit line breaks survive; overlays are optional', () => {
  const input = {
    ...base(),
    overlays: [],
    captions: [
      { start: 1, end: 2, text: 'Yeah!' },
      { start: 1.5, end: 2.5, text: 'Really?\nWait.' },
    ],
  };
  const result = compileVideoTextAss(input);
  assert.equal(result.plan.overlays.length, 0);
  assert.ok(result.ass.includes('0:00:01.00,0:00:02.00'));
  assert.ok(result.ass.includes('0:00:01.50,0:00:02.50'));
  assert.ok(result.ass.includes('Really?\\NWait.'));
});
test('explicit styles and simple fades apply without inventing another text event', () => {
  const result = compileVideoTextAss({
    ...base(),
    captions: [],
    overlays: [
      {
        start: 1,
        end: 3,
        text: '文字',
        fadeInMs: 100,
        fadeOutMs: 200,
        style: {
          fontFamily: 'Noto Sans SC',
          fontSize: 50,
          alignment: 5,
          marginVertical: 0,
          color: '#00FF00',
          backgroundColor: '#00000080',
        },
      },
    ],
  });
  assert.equal(result.plan.overlays[0]!.style.alignment, 5);
  assert.ok(result.ass.includes('{\\fad(100,200)}文字'));
  assert.equal(
    result.ass.split('\n').filter((line) => line.startsWith('Dialogue:'))
      .length,
    1,
  );
});
test('invalid or unsafe plans fail before video execution', () => {
  const cases = [
    { ...base(), unknown: true },
    { ...base(), width: 721 },
    { ...base(), width: 3840, height: 2160 },
    { ...base(), captions: [], overlays: [] },
    { ...base(), captionStyle: { fontFamily: 'Helvetica Neue' } },
    { ...base(), captionStyle: { color: 'white' } },
    { ...base(), captions: [{ start: 2, end: 1, text: 'Wrong' }] },
    { ...base(), captions: [{ start: 1, end: 1.001, text: 'Collapsed' }] },
    { ...base(), captions: [{ start: 0, end: 1, text: '{\\p1} malicious' }] },
    {
      ...base(),
      captions: [
        { start: 0, end: 1, text: 'Test', fadeInMs: 1000, fadeOutMs: 1000 },
      ],
    },
    { ...base(), captions: [{ start: NaN, end: 1, text: 'NaN' }] },
    { ...base(), captionStyle: { marginLeft: 400, marginRight: 400 } },
  ];
  for (const plan of cases) assert.throws(() => parseVideoTextPlan(plan));
});
test('captions reject control characters while preserving line breaks and Unicode', () => {
  for (let code = 0; code <= 0x9f; code++) {
    if ((code >= 0x20 && code < 0x7f) || code === 0x0a) continue;
    const input = base();
    input.captions[0]!.text = `Before${String.fromCodePoint(code)}after`;
    assert.throws(() => parseVideoTextPlan(input), /control characters/);
  }
  const input = base();
  input.captions[0]!.text = '中文 😀\nNext line';
  assert.equal(
    parseVideoTextPlan(input).captions[0]!.text,
    input.captions[0]!.text,
  );
});
test('CLI rejects unsupported flags and invalid remote wait before auth, upload or rendering', async () => {
  await assert.rejects(
    runVideoTextCommand([
      'render',
      '--video',
      '/missing',
      '--plan',
      '/missing',
      '--output',
      '/missing.mp4',
      '--surprise',
      '1',
    ]),
    /Unknown/,
  );
  await assert.rejects(
    runVideoTextCommand([
      'render',
      '--remote',
      '--video',
      '/missing',
      '--plan',
      '/missing',
      '--output',
      '/missing.mp4',
      '--wait-seconds',
      'NaN',
    ]),
    /wait-seconds/,
  );
  await assert.rejects(
    runVideoTextCommand([
      'render',
      '--remote',
      '--video',
      '/missing',
      '--plan',
      '/missing',
      '--output',
      '/missing.mp4',
      '--operation-id',
      'bad',
    ]),
    /UUID/,
  );
});
