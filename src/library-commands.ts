import { readFile } from 'node:fs/promises';

import { resolveFreshRemoteAuth } from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import { isNetworkFailure, isTlsFailure } from './network-diagnostics.js';

const help = `Personal PostPlus library — the same files and brands as Web and MCP.

  postplus library assets [--query <text>] [--type image|video|audio|document] [--source upload|generated|imported] [--favorites] [--archived] [--collection <id>] [--cursor <cursor>] [--limit <1..48>]
  postplus library asset <id>
  postplus library rename <id> --revision <n> --name <name>
  postplus library favorite|unfavorite|archive|restore <id> --revision <n>
  postplus library delete <id> --revision <n> --confirm-permanent
  postplus library register --reference <postplus-media://...> --name <name> --mime <type>
  postplus library complete-upload --reference <postplus-media://uploads/...> --name <name> --mime <type> --sha256 <original-hash>
  postplus library brand-website --url <https://official-website>
  postplus library brands [--query <text>] [--cursor <cursor>]
  postplus library brand <id> [--version <id>]
  postplus library brand-save <id> --revision <n> --file <content.json>
  postplus library brand-adopt <id> --revision <n> --request-id <uuid>
  postplus library brand-history <id> [--before <version-number>]
  postplus library brand-use <id> --sections facts,voice,visual [--version <id>]
  postplus library collections
  postplus library collection-create <uuid> --name <name>
  postplus library collection-add|collection-remove <collection-id> --asset <asset-id>

All support --json. Read IDs and revisions before edits. Create a brand with a new
UUID and revision 0; retry the same ID and content after an uncertain response.
Brand-website returns a source-backed proposal and may save verified website images.
Review preview.content before brand-save. Unknown facts remain empty; this does not adopt a brand.
Saving a draft does not adopt it. Adopt only on explicit user intent, retaining
the request UUID on retries. Versions remain immutable. Brand-use returns known
facts for a brief; files are selected separately. No generation or publication.
Archive is reversible. Delete permanently removes the original file and requires
explicit user intent. No automatic cleanup. This library is personal only.
`;

export async function parseLibraryCommand(
  args: string[],
): Promise<Record<string, unknown>> {
  const tokens = args.filter((v) => v !== '--json'),
    action = tokens.shift();
  const positional: string[] = [],
    flags = new Map<string, string | true>();
  const booleans = new Set(['favorites', 'archived', 'confirm-permanent']);
  while (tokens.length) {
    const value = tokens.shift()!;
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (flags.has(key)) throw new Error(`Duplicate --${key}.`);
    if (booleans.has(key)) flags.set(key, true);
    else {
      const next = tokens.shift();
      if (!next || next.startsWith('--'))
        throw new Error(`Missing --${key} value.`);
      flags.set(key, next);
    }
  }
  const take = (key: string, required = false) => {
    const value = flags.get(key);
    flags.delete(key);
    if (required && (typeof value !== 'string' || !value.trim()))
      throw new Error(`Provide --${key}.`);
    return typeof value === 'string' ? value : undefined;
  };
  const yes = (key: string) => {
    const value = flags.get(key) === true;
    flags.delete(key);
    return value;
  };
  const number = (key: string, required = false) => {
    const value = take(key, required);
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error(`--${key} must be a non-negative integer.`);
    return n;
  };
  const id = () => {
    if (positional.length !== 1) throw new Error('Provide exactly one ID.');
    return positional.pop()!;
  };
  let body: Record<string, unknown>;
  switch (action) {
    case 'assets':
      body = {
        action: 'assets',
        query: {
          q: take('query'),
          type: take('type'),
          source: take('source'),
          favorite: yes('favorites'),
          archived: yes('archived') ? 'archived' : 'active',
          collection_id: take('collection'),
          cursor: take('cursor'),
          limit: number('limit'),
        },
      };
      break;
    case 'asset':
      body = { action: 'asset', asset_id: id() };
      break;
    case 'rename':
      body = {
        action: 'change_asset',
        change: {
          action: 'rename',
          asset_id: id(),
          revision: number('revision', true),
          name: take('name', true),
        },
      };
      break;
    case 'favorite':
    case 'unfavorite':
    case 'archive':
    case 'restore':
      body = {
        action: 'change_asset',
        change: {
          action:
            action === 'favorite' || action === 'unfavorite'
              ? 'favorite'
              : 'archive',
          asset_id: id(),
          revision: number('revision', true),
          value: action === 'favorite' || action === 'archive',
        },
      };
      break;
    case 'delete':
      if (!yes('confirm-permanent'))
        throw new Error('Permanent deletion requires --confirm-permanent.');
      body = {
        action: 'change_asset',
        change: {
          action: 'delete',
          asset_id: id(),
          revision: number('revision', true),
          confirm_permanent: true,
        },
      };
      break;
    case 'register':
      body = {
        action: 'register_file',
        reference: take('reference', true),
        name: take('name', true),
        mime_type: take('mime', true),
      };
      break;
    case 'complete-upload': {
      const reference = new URL(take('reference', true)!);
      if (
        reference.protocol !== 'postplus-media:' ||
        reference.hostname !== 'uploads'
      )
        throw new Error('Choose the original PostPlus upload reference.');
      body = {
        action: 'register_upload',
        storage_path: reference.pathname
          .slice(1)
          .split('/')
          .map(decodeURIComponent)
          .join('/'),
        name: take('name', true),
        mime_type: take('mime', true),
        sha256: take('sha256', true),
      };
      break;
    }
    case 'brand-website':
      body = { action: 'preview_brand_website', website: take('url', true) };
      break;
    case 'brands':
      body = { action: 'brands', q: take('query'), before: take('cursor') };
      break;
    case 'brand':
      body = { action: 'brand', brand_id: id(), version_id: take('version') };
      break;
    case 'brand-save': {
      const brand_id = id(),
        expected_revision = number('revision', true),
        file = take('file', true)!;
      body = {
        action: 'save_brand',
        brand_id,
        expected_revision,
        content: JSON.parse(await readFile(file, 'utf8')) as unknown,
      };
      break;
    }
    case 'brand-adopt':
      body = {
        action: 'adopt_brand',
        brand_id: id(),
        draft_revision: number('revision', true),
        request_id: take('request-id', true),
      };
      break;
    case 'brand-history':
      body = {
        action: 'brand_history',
        brand_id: id(),
        before: number('before'),
      };
      break;
    case 'brand-use':
      body = {
        action: 'resolve_brand',
        brand_id: id(),
        version_id: take('version'),
        sections: take('sections', true)!.split(','),
      };
      break;
    case 'collections':
      body = { action: 'collections' };
      break;
    case 'collection-create':
      body = {
        action: 'create_collection',
        id: id(),
        name: take('name', true),
      };
      break;
    case 'collection-add':
    case 'collection-remove':
      body = {
        action: 'collection_member',
        collection_id: id(),
        asset_id: take('asset', true),
        present: action === 'collection-add',
      };
      break;
    default:
      throw new Error('Use postplus library --help.');
  }
  if (positional.length || flags.size)
    throw new Error(
      `Unexpected library arguments: ${[...positional, ...[...flags.keys()].map((k) => `--${k}`)].join(' ')}.`,
    );
  return body;
}

export async function runLibraryCommand(
  args: string[],
  deps: {
    request?: (body: Record<string, unknown>) => Promise<Response>;
    output?: (text: string) => void;
  } = {},
): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(text));
  if (!args.length || args.some((v) => ['help', '--help', '-h'].includes(v))) {
    output(help);
    return 0;
  }
  const body = await parseLibraryCommand(args);
  let response: Response;
  try {
    response = deps.request
      ? await deps.request(body)
      : await sendAuthedCloudRequest({
          auth: await resolveFreshRemoteAuth(),
          pathName: '/api/postplus-cli/library',
          method: 'POST',
          body,
          timeoutMs: body.action === 'preview_brand_website' ? 300000 : 120000,
          retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
        });
  } catch (error) {
    if (!isNetworkFailure(error) && !isTlsFailure(error)) throw error;
    output(
      `${JSON.stringify({ code: 'library_response_unconfirmed', error: error instanceof Error ? error.message : 'Response unavailable.', next: 'Read the original ID. Retry the exact same request and revision; do not create a replacement brand, version or file.' }, null, 2)}\n`,
    );
    return 2;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    output(
      `${JSON.stringify({ code: 'library_response_unconfirmed', next: 'Read the original ID and retry the unchanged request.' })}\n`,
    );
    return 2;
  }
  output(`${JSON.stringify(payload, null, 2)}\n`);
  return response.ok ? 0 : 1;
}
