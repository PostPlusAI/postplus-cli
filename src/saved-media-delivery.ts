/** HTML navigation links to saved files. Playback is renewed by the signed-in
 * PostPlus file page; offline reports never contain account credentials. */
export function appendSavedMediaLinks(
  html: string,
  inputs: { name: string; payload: unknown }[],
  apiBaseUrl: string | null,
): string {
  const saved = new Map<string, { source: string; label: string }>();
  const gaps = new Map<string, string>();
  function visit(value: unknown, source: string, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 10) return;
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, source, depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    const media = record.media_preservation;
    if (media && typeof media === 'object' && !Array.isArray(media)) {
      const saved = media as Record<string, unknown>;
      if (
        ['saving', 'pending', 'incomplete', 'failed'].includes(
          String(saved.state),
        )
      )
        gaps.set(
          source,
          (typeof saved.savedCount === 'number'
            ? saved.savedCount
            : 'Unknown') +
            ' of ' +
            (typeof saved.totalCount === 'number'
              ? saved.totalCount
              : 'unknown') +
            (['saving', 'pending'].includes(String(saved.state))
              ? ' files saved; saving is still in progress on the original task.'
              : ' files saved; some media could not be saved for later access.'),
        );
    }

    if (typeof record.mediaReference === 'string') {
      const ref = new URL(record.mediaReference);
      if (
        ref.protocol !== 'postplus-media:' ||
        !['results', 'uploads'].includes(ref.hostname) ||
        !ref.pathname ||
        ref.search ||
        ref.hash ||
        ref.username ||
        ref.password
      )
        throw Error('Invalid saved media reference.');
      const label =
        typeof record.name === 'string'
          ? record.name
          : typeof record.kind === 'string'
            ? record.kind + ' · ' + ref.pathname.split('/').at(-1)
            : ref.pathname.split('/').at(-1) || 'Saved file';
      saved.set(ref.href, { source, label });
    }
    for (const key of [
      'result',
      'output',
      'outputs',
      'data',
      'artifacts',
      'media_preservation',
    ])
      visit(record[key], source, depth + 1);
  }
  inputs.forEach((input) => visit(input.payload, input.name));
  if (!saved.size && !gaps.size) return html;
  if (!apiBaseUrl && saved.size)
    throw Error(
      'Configure the PostPlus API URL to reopen saved media from this report.',
    );
  const base = apiBaseUrl ? new URL(apiBaseUrl) : null;
  if (
    base &&
    (!['https:', 'http:'].includes(base.protocol) ||
      base.username ||
      base.password)
  )
    throw Error('Invalid PostPlus API origin.');
  const esc = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c]!,
    );
  const links = [...saved]
    .map(([reference, file]) => {
      const delivery = new URL('/connect/media', base!.origin);
      delivery.searchParams.set('reference', reference);
      return (
        '<li><a href="' +
        esc(delivery.href) +
        '" target="_blank" rel="noopener noreferrer">' +
        esc(file.label) +
        '</a><small> · ' +
        esc(file.source) +
        '</small></li>'
      );
    })
    .join('');
  const section =
    '<section style="padding:24px;max-width:1500px;margin:auto" aria-label="Saved PostPlus media"><h2>Saved media (' +
    saved.size +
    ')</h2><p>Reopen these saved files after PostPlus sign-in. This renews playback access without collecting, generating or charging again. Original source previews above may expire.</p><ul>' +
    links +
    '</ul>' +
    [...gaps]
      .map(
        ([source, message]) =>
          '<p>' + esc(source) + ': ' + esc(message) + '</p>',
      )
      .join('') +
    '</section>';
  if (!html.includes('</body>')) throw Error('Report has no body closing tag.');
  return html.replace('</body>', section + '</body>');
}
