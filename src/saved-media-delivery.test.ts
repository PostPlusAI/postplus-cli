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
