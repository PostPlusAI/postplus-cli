import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendSavedMediaLinks } from './saved-media-delivery.js';

test('an old report reopens saved media through its configured PostPlus origin, never through expired provider access', () => {
  const payload = {
    output: {
      media_preservation: {
        artifacts: [
          {
            mediaReference: 'postplus-media://results/owner/video.mp4',
            kind: 'video',
            source_url: 'https://provider.test/expired?token=secret',
          },
        ],
      },
    },
  };
  const input = { name: '<original>', payload };
  const original = JSON.stringify(payload);
  const html = appendSavedMediaLinks(
    '<body><p>Original records</p></body>',
    [input, input],
    'https://staging.postplus.io/api',
  );
  assert.match(html, /Saved media \(1\)/);
  assert.match(
    html,
    /https:\/\/staging.postplus.io\/connect\/media\?reference=postplus-media/,
  );
  assert.match(html, /&lt;original&gt;/);
  assert.doesNotMatch(html, /token=|provider.test|secret/);
  assert.equal(JSON.stringify(payload), original);
});
test('a report without saved files stays unchanged and cannot turn arbitrary URLs into owned files', () => {
  assert.equal(
    appendSavedMediaLinks(
      '<body></body>',
      [{ name: 'x', payload: { output: { items: [] } } }],
      'https://staging.postplus.io',
    ),
    '<body></body>',
  );
  assert.throws(
    () =>
      appendSavedMediaLinks(
        '<body></body>',
        [
          {
            name: 'x',
            payload: {
              output: {
                artifacts: [{ mediaReference: 'https://evil.test/file' }],
              },
            },
          },
        ],
        'https://staging.postplus.io',
      ),
    /Invalid saved/,
  );
});

test('permanent missing media remains visible even when zero files could be saved', () => {
  const html = appendSavedMediaLinks(
    '<body></body>',
    [
      {
        name: 'original',
        payload: {
          output: {
            media_preservation: {
              state: 'incomplete',
              savedCount: 0,
              totalCount: 2,
              retryable: false,
            },
          },
        },
      },
    ],
    null,
  );
  assert.match(html, /Saved media \(0\)/);
  assert.match(html, /0 of 2 files saved; some media could not be saved/);
});


test('early reports retain unopened archive references separately from saved files', () => {
  const id = 'aabbccdd-1234-4567-89ab-aabbccddeeff';
  const reference = `postplus-research-media://${id}`;
  const missing = {media_ref_id: id, kind: 'video', source_url: 'https://provider.test/video?token=private'};
  const input = (ready: boolean) => ({
    name: 'original',
    payload: {
      output: {
        media_preservation: {
          state: ready ? 'complete' : 'saving',
          savedCount: ready ? 1 : 0,
          totalCount: 1,
          missing: ready ? [] : [{...missing, retryable: true}, {media_ref_id: id + '/invalid', retryable: true}],
          artifacts: ready ? [{mediaReference: reference, kind: 'video'}] : [],
        },
      },
    },
  });
  const early = appendSavedMediaLinks('<body></body>', [input(false)], 'https://staging.postplus.io');
  assert.match(early, /Saved media \(0\)/);
  assert.match(early, /Media still saving/);
  assert.ok(early.includes(encodeURIComponent(reference)));
  assert.doesNotMatch(early, /token=|provider.test|invalid/);
  const later = appendSavedMediaLinks('<body></body>', [input(false), input(true)], 'https://staging.postplus.io');
  assert.match(later, /Saved media \(1\)/);
  assert.doesNotMatch(later, /Media still saving/);
  assert.equal(later.split(encodeURIComponent(reference)).length, 2);
});

test('reports preserve exact stable research identities without exposing provider URLs', () => {
  const reference = 'postplus-research-media://aabbccdd-1234-4567-89ab-aabbccddeeff';
  const html = appendSavedMediaLinks('<body></body>', [{ name: 'Research', payload: { output: { media_preservation: { artifacts: [{ mediaReference: reference, kind: 'video' }] } } } }], 'https://staging.postplus.io');
  assert.ok(html.includes(encodeURIComponent(reference)));
  for (const invalid of [reference + '/file', reference + '?token=private', 'postplus-research-media://results/owner/file']) {
    assert.throws(() => appendSavedMediaLinks('<body></body>', [{ name: 'Research', payload: { artifacts: [{ mediaReference: invalid }] } }], 'https://staging.postplus.io'), /Invalid saved/);
  }
});
