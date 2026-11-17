const RESEARCH_MEDIA_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESEARCH_MEDIA_PREFIX = 'postplus-research-media://';

/** HTML navigation links to research originals. Playback is renewed by the signed-in
 * PostPlus file page; offline reports never contain account credentials. */
export function appendSavedMediaLinks(
  html: string,
  inputs: { name: string; payload: unknown }[],
  apiBaseUrl: string | null,
): string {
  const saved = new Map<string, { source: string; label: string }>();
  const pending = new Map<string, { source: string; label: string }>();
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
      const archive = media as Record<string, unknown>;
      if (
        ['saving', 'pending', 'incomplete', 'failed'].includes(
          String(archive.state),
        )
      )
        gaps.set(
          source,
          (typeof archive.savedCount === 'number'
            ? archive.savedCount
            : 'Unknown') +
            ' of ' +
            (typeof archive.totalCount === 'number'
              ? archive.totalCount
              : 'unknown') +
            (['saving', 'pending'].includes(String(archive.state))
              ? ' files saved; saving is still in progress on the original task.'
              : ' files saved; some media could not be saved for later access.'),
        );
      if (Array.isArray(archive.missing)) {
        for (const gap of archive.missing) {
          if (
            gap?.retryable === true &&
            typeof gap.media_ref_id === 'string' &&
            RESEARCH_MEDIA_ID.test(gap.media_ref_id)
          ) {
            const ref = `${RESEARCH_MEDIA_PREFIX}${gap.media_ref_id}`;
            const kind =
              gap.kind === 'video' || gap.kind === 'image' ? gap.kind : 'media';
            pending.set(ref, { source, label: `Open ${kind} archive` });
          }
        }
      }
    }

    if (typeof record.mediaReference === 'string') {
      const ref = new URL(record.mediaReference);
      const research =
        record.mediaReference.toLowerCase().startsWith(RESEARCH_MEDIA_PREFIX) &&
        RESEARCH_MEDIA_ID.test(record.mediaReference.slice(RESEARCH_MEDIA_PREFIX.length));
      if (
        (!research && (ref.protocol !== 'postplus-media:' || !['results','uploads'].includes(ref.hostname) || !ref.pathname)) ||
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
            ? record.kind + ' · ' + (research ? ref.hostname : ref.pathname.split('/').at(-1))
            : (research ? ref.hostname : ref.pathname.split('/').at(-1)) || 'Saved file';
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
  for (const ref of saved.keys()) pending.delete(ref);
  if (!saved.size && !pending.size && !gaps.size) return html;
  if (!apiBaseUrl && (saved.size || pending.size))
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
  const links = (files: typeof saved) => [...files]
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
    links(saved) +
    '</ul>' +
    (pending.size
      ? '<h3>Media still saving</h3><p>Keep these links to reopen the same originals when they are ready.</p><ul>' +
        links(pending) + '</ul>'
      : '') +
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
