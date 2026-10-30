import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { resolveApiBaseUrlState } from './local-state.js';
import { appendSavedMediaLinks } from './saved-media-delivery.js';

type Row = Record<string, unknown>;
const obj = (x: unknown): Row =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Row) : {};
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string =>
  typeof x === 'string'
    ? x
    : typeof x === 'number' && Number.isSafeInteger(x)
      ? String(x)
      : '';
const esc = (x: unknown) =>
  str(x).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
function url(x: unknown, logo = false): string {
  const value = str(x);
  if (!value) return '';
  const parsed = new URL(
    value,
    logo &&
    (value.startsWith('/images/ad-library/brands/') ||
      /^\/api\/ad-library\/brands\/[a-z0-9-]+\/logo\?v=[a-f0-9]{64}$/.test(
        value,
      ))
      ? 'https://postplus.io'
      : undefined,
  );
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error(
      'Unsafe report URL. Only HTTP(S) without credentials is supported.',
    );
  return parsed.href;
}
const date = (x: unknown) => {
  if (!x) return '';
  const d = new Date(typeof x === 'number' ? x * 1000 : str(x));
  return Number.isFinite(d.valueOf())
    ? d
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, ' UTC')
    : '';
};
export type ReportCreative = {
  body: string;
  headline: string;
  description: string;
  destination: string;
  destinationState?: 'unsupported_map';
  cta: string;
  media: { kind: string; url: string; poster: string; contentHash?: string }[];
};
export type ReportAd = {
  id: string;
  advertiser: string;
  advertiserId: string;
  advertiserPageId?: string;
  advertiserUrl?: string;
  logo: string;
  status: string;
  observed: string;
  start: string;
  end: string;
  platforms: string[];
  collatedAds: number | null;
  source: string;
  creatives: ReportCreative[];
};
export type ReportInput = { name: string; payload: unknown };
export type ReportSource = {
  name: string;
  state: string;
  count: number | null;
  note: string;
};
export function normalizeAdReport(inputs: ReportInput[]) {
  const ads = new Map<string, ReportAd>();
  const sources: ReportSource[] = [];
  for (const input of inputs) {
    const envelope = obj(input.payload);
    const stored =
      envelope.schemaVersion === 1 && Array.isArray(envelope.items);
    if (!stored && envelope.routeKey !== 'facebook-ads-library')
      throw new Error(`Unsupported ad report input: ${input.name}`);
    const state = stored ? 'stored snapshots' : str(envelope.status);
    if (!stored && state !== 'completed') {
      if (!state) throw new Error(`Missing operation status: ${input.name}`);
      const error = obj(envelope.error);
      sources.push({
        name: input.name,
        state,
        count: null,
        note:
          str(error.message) ||
          str(envelope.error) ||
          (['failed', 'canceled', 'cancelled'].includes(state)
            ? 'Collection did not complete successfully. This is not evidence of no ads.'
            : 'Collection has not completed. This is not evidence of no ads.'),
      });
      continue;
    }
    const data = stored ? envelope : obj(envelope.output);
    if (!Array.isArray(data.items))
      throw new Error(`Missing ad items: ${input.name}`);
    sources.push({
      name: input.name,
      state,
      count: data.items.length,
      note:
        stored && data.nextOffset != null
          ? 'More stored results are available; this input is only one page.'
          : data.items.length
            ? ''
            : 'No records returned by this collection; this does not prove the advertiser has no ads.',
    });
    for (const value of data.items) {
      const a = obj(value),
        snapshot = obj(a.snapshot),
        brand = obj(arr(a.brands)[0]);
      const id = str(stored ? a.archive_id : a.ad_archive_id);
      if (!id) throw new Error(`Ad is missing its archive ID: ${input.name}`);
      const presentation = obj(a.presentation);
      const common = obj(presentation.common);
      const projected = arr(presentation.creatives);
      const rawCreatives = stored
        ? projected.length
          ? projected
          : [Object.keys(common).length ? common : a]
        : arr(snapshot.cards).length
          ? arr(snapshot.cards)
          : [snapshot];
      const creatives = rawCreatives.map((raw) => {
        const c = stored
          ? {
              ...common,
              ...Object.fromEntries(
                Object.entries(obj(raw)).filter(([, value]) => value != null),
              ),
            }
          : obj(raw);
        const media: ReportCreative['media'] = [];
        if (stored) {
          const storedMedia = arr(a.media).map(obj);
          for (const m of storedMedia)
            if (
              ['video', 'image'].includes(str(m.kind)) &&
              (!projected.length || m.sort_order === c.sortOrder)
            )
              media.push({
                kind: str(m.kind),
                url: url(m.url),
                poster:
                  m.kind === 'video' &&
                  storedMedia.filter(
                    (item) =>
                      item.kind === 'video' && item.sort_order === m.sort_order,
                  ).length === 1 &&
                  storedMedia.filter(
                    (item) =>
                      item.kind === 'thumbnail' &&
                      item.sort_order === m.sort_order,
                  ).length === 1
                    ? url(
                        storedMedia.find(
                          (thumbnail) =>
                            thumbnail.kind === 'thumbnail' &&
                            thumbnail.sort_order === m.sort_order,
                        )?.url,
                      )
                    : '',
                contentHash: str(m.content_sha256),
              });
        } else {
          for (const v of [
            ...arr(c.videos),
            ...(c.video_hd_url || c.video_sd_url ? [c] : []),
          ].map(obj))
            media.push({
              kind: 'video',
              url: url(v.video_hd_url || v.video_sd_url),
              poster: url(v.video_preview_image_url),
            });
          for (const i of [
            ...arr(c.images),
            ...(c.original_image_url || c.resized_image_url ? [c] : []),
          ].map(obj))
            media.push({
              kind: 'image',
              url: url(i.original_image_url || i.resized_image_url),
              poster: '',
            });
        }
        const destination = c.destinationUrl || c.link_url || snapshot.link_url;
        const unsupportedMap = /^fbgeo:/i.test(str(destination));
        return {
          body:
            str(obj(c.body).text) ||
            str(c.body) ||
            str(obj(snapshot.body).text) ||
            str(snapshot.body),
          headline: str(c.headline || c.title || snapshot.title),
          description: str(
            c.description || c.link_description || snapshot.link_description,
          ),
          destination: unsupportedMap ? '' : url(destination),
          ...(unsupportedMap
            ? { destinationState: 'unsupported_map' as const }
            : {}),
          cta: str(c.ctaText || c.cta_text || snapshot.cta_text),
          media,
        };
      });
      const ad: ReportAd = {
        id,
        advertiser:
          str(
            stored
              ? obj(a.advertiser).name || brand.name
              : a.page_name || snapshot.page_name,
          ) || 'Advertiser not provided',
        advertiserId: str(a.page_id) || str(brand.slug) || id,
        advertiserPageId: str(a.page_id) || undefined,
        advertiserUrl:
          url(
            stored ? obj(a.advertiser).page_url : snapshot.page_profile_uri,
          ) || undefined,
        logo: url(
          stored ? brand.logo_url : snapshot.page_profile_picture_url,
          true,
        ),
        status: stored
          ? ['active', 'inactive'].includes(str(a.status))
            ? str(a.status)
            : 'unknown'
          : a.is_active === true
            ? 'active'
            : a.is_active === false
              ? 'inactive'
              : 'unknown',
        observed: date(a.observed_at || data.fetchedAt),
        start: date(a.delivery_started_at || a.start_date),
        end: date(a.delivery_ended_at || a.end_date),
        collatedAds:
          Number.isSafeInteger(a.collation_count) &&
          Number(a.collation_count) > 1
            ? Number(a.collation_count)
            : null,
        platforms: arr(
          presentation.publisherPlatforms ||
            a.publisher_platform ||
            a.publisher_platforms,
        ).map(str),
        source:
          url(a.source_url || a.ad_library_url) ||
          `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}`,
        creatives,
      };
      const prior = ads.get(id);
      if (prior) {
        if (prior.advertiserId !== ad.advertiserId)
          throw new Error(`Conflicting advertiser identity for ad ${id}`);
        const merged = [...prior.creatives];
        for (const creative of ad.creatives)
          if (
            !merged.some((c) => JSON.stringify(c) === JSON.stringify(creative))
          )
            merged.push(creative);
        ads.set(id, {
          ...(ad.observed > prior.observed ? ad : prior),
          creatives: merged,
        });
      } else ads.set(id, ad);
    }
  }
  return { ads: [...ads.values()], sources };
}

/** Only verified video bytes from the same advertiser can share a card. */
export function reportCreativeGroupKey(ad: ReportAd): string {
  const media = ad.creatives.flatMap((creative) => creative.media);
  return media.length &&
    media.every(
      (item) =>
        item.kind === 'video' && /^[a-f0-9]{64}$/.test(item.contentHash ?? ''),
    )
    ? JSON.stringify([
        ad.advertiserId,
        ad.creatives.map((creative) =>
          creative.media.map((item) => item.contentHash),
        ),
      ])
    : `ad:${ad.id}`;
}

export type AdReportSummary = {
  raw_records: number;
  unique_ads: number;
  cards: number;
  /** Saved media references, not a count of verified playable media. */
  media_references: number;
  advertiser_total: number;
  advertisers: {
    page_id: string | null;
    name: string;
    ad_count: number;
    destination_domains: string[];
  }[];
  advertisers_shown: number;
  /** Whether every loaded advertiser and source record fits this summary. */
  summary_complete: boolean;
  sources: ReportSource[];
};

/** Bounded projection of saved evidence; never truncates a record or identifier. */
export function summarizeAdReport(inputs: ReportInput[]): AdReportSummary {
  const model = normalizeAdReport(inputs);
  const { ads, sources } = model;
  const advertisers = new Map<string, AdReportSummary['advertisers'][number]>();
  for (const ad of ads) {
    const advertiser = advertisers.get(ad.advertiserId) ?? {
      page_id: ad.advertiserPageId ?? null,
      name: ad.advertiser,
      ad_count: 0,
      destination_domains: [],
    };
    advertiser.ad_count++;
    for (const creative of ad.creatives) {
      if (!creative.destination) continue;
      const domain = new URL(creative.destination).hostname;
      if (!advertiser.destination_domains.includes(domain))
        advertiser.destination_domains.push(domain);
    }
    advertiser.destination_domains.sort();
    advertisers.set(ad.advertiserId, advertiser);
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [...advertisers.values()].sort(
    (a, b) =>
      b.ad_count - a.ad_count ||
      compare(a.page_id ?? '', b.page_id ?? '') ||
      compare(a.name, b.name),
  );
  const summary: AdReportSummary = {
    raw_records: sources.reduce(
      (total, source) => total + (source.count ?? 0),
      0,
    ),
    unique_ads: ads.length,
    cards: new Set(ads.map(reportCreativeGroupKey)).size,
    media_references: ads.reduce(
      (total, ad) =>
        total +
        ad.creatives.reduce(
          (count, creative) => count + creative.media.length,
          0,
        ),
      0,
    ),
    advertiser_total: rows.length,
    advertisers: [],
    advertisers_shown: 0,
    summary_complete: false,
    sources: [],
  };
  const fits = () =>
    new TextEncoder().encode(JSON.stringify(summary)).byteLength <= 8 * 1024;
  for (const source of [...sources].sort((a, b) =>
    compare(JSON.stringify(a), JSON.stringify(b)),
  )) {
    summary.sources.push(source);
    if (!fits()) summary.sources.pop();
  }
  for (const advertiser of rows) {
    if (summary.advertisers.length === 20) break;
    summary.advertisers.push(advertiser);
    summary.advertisers_shown = summary.advertisers.length;
    if (!fits()) {
      summary.advertisers.pop();
      summary.advertisers_shown = summary.advertisers.length;
    }
  }
  summary.summary_complete =
    summary.advertisers_shown === rows.length &&
    summary.sources.length === sources.length;
  return summary;
}

function emptyReportMessage(ads: ReportAd[], sources: ReportSource[]): string {
  if (ads.length) return 'No ads match the current filters.';
  const failed = sources.some((source) =>
    ['failed', 'canceled', 'cancelled'].includes(source.state),
  );
  const pending = sources.some(
    (source) =>
      ![
        'completed',
        'stored snapshots',
        'failed',
        'canceled',
        'cancelled',
      ].includes(source.state),
  );
  if (pending)
    return `Collection is still in progress.${failed ? ' Some sources failed; some results are unavailable.' : ''} This is not evidence of no ads.`;
  if (failed)
    return 'No ads are available from these sources. Collection failed or was canceled; some results are unavailable. This is not evidence of no ads.';
  return 'Collection completed with no returned ads. This does not establish that no ads exist.';
}

export function adTimingSignal(
  ad: Pick<ReportAd, 'start' | 'end' | 'observed' | 'status'>,
) {
  const start = Date.parse(ad.start);
  const observed = Date.parse(ad.observed);
  if (!Number.isFinite(start) || !Number.isFinite(observed) || observed < start)
    return null;
  const elapsedDays = Math.floor((observed - start) / 86_400_000);
  const end = Date.parse(ad.end);
  const reportedSpanDays =
    ad.status === 'inactive' &&
    Number.isFinite(end) &&
    end >= start &&
    end <= observed
      ? Math.floor((end - start) / 86_400_000)
      : null;
  return {
    elapsedDays,
    reportedSpanDays,
    prioritize: ad.status === 'active' && observed - start > 7 * 86_400_000,
  };
}

function timingMarkup(ad: ReportAd): string {
  const timing = adTimingSignal(ad);
  if (!timing) return '';
  return `<div class="checked">Elapsed since reported start: ${timing.elapsedDays} days at observation${timing.reportedSpanDays === null ? '' : `<br>Reported start-to-end span: ${timing.reportedSpanDays} days`}</div>${timing.prioritize ? '<p class="notice">Research signal: observed active more than 7 days after its reported start. Worth reviewing first; this does not establish uninterrupted delivery, learning-phase completion, or positive ROAS.</p>' : ''}`;
}

export function renderAdReport(inputs: ReportInput[]): string {
  const { ads, sources } = normalizeAdReport(inputs);
  const sourceNotices = [
    ...new Set(
      sources
        .filter((source) => source.note && source.state !== 'completed')
        .map((source) => source.note),
    ),
  ];
  const brands = [...new Map(ads.map((a) => [a.advertiserId, a])).values()];
  const logo = (a: ReportAd) =>
    a.logo
      ? `<img class="logo" src="${esc(a.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : '<span class="logo missing" aria-hidden="true">—</span>';
  const link = (href: string, label: string, className = '') =>
    `<a class="${className}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  const calendarDate = (value: string) =>
    new Date(value).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const platform = (name: string) => {
    const key = name.toLowerCase();
    const icons: Record<string, string> = {
      facebook:
        '<path fill="currentColor" d="M12 2a10 10 0 0 0-1.6 19.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.4h-1.2c-1.2 0-1.6.7-1.6 1.5v2h2.7l-.4 2.9h-2.3v7A10 10 0 0 0 12 2Z"/>',
      instagram:
        '<rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor"/>',
      messenger:
        '<path fill="currentColor" d="M12 2C6.5 2 2 6.1 2 11.2c0 2.9 1.5 5.5 3.8 7.2V22l3.4-1.9c.9.2 1.8.3 2.8.3 5.5 0 10-4.1 10-9.2S17.5 2 12 2Zm1 12-2.7-2.9L5 14l5.9-6.2 2.8 3L19 8l-6 6Z"/>',
    };
    return icons[key]
      ? `<svg class="platform-icon" role="img" aria-label="${esc(name)}" viewBox="0 0 24 24"><title>${esc(name)}</title>${icons[key]}</svg>`
      : `<span>${esc(name)}</span>`;
  };
  const creative = (a: ReportAd, c: ReportCreative, i: number) => {
    const hasDestination =
      c.headline || c.description || c.destination || c.destinationState;
    return `<section class="variant" data-variant="${i}" ${i ? 'hidden' : ''} aria-label="Creative ${i + 1} of ${a.creatives.length}">
      <div class="identity">${logo(a)}<div><strong>${esc(a.advertiser)}</strong><span class="sponsored">Sponsored</span></div></div>
      ${c.body ? `<div class="copy">${esc(c.body)}</div>` : ''}
      <div class="media">${c.media
        .map((m) =>
          m.kind === 'video'
            ? `<video controls playsinline preload="none" src="${esc(m.url)}" ${m.poster ? `poster="${esc(m.poster)}"` : ''} aria-label="Video ad by ${esc(a.advertiser)}"></video>`
            : `<img src="${esc(m.url)}" loading="lazy" alt="Ad creative by ${esc(a.advertiser)}">`,
        )
        .join('')}</div>
      ${!c.media.length ? '<p class="copy muted">Media not supplied. Open the source to inspect this ad.</p>' : ''}
      ${hasDestination ? `<div class="destination"><div class="destination-copy">${c.destinationState === 'unsupported_map' ? '<div class="description">Map destination is not supported in this viewer.</div>' : c.destination ? `<div class="domain">${esc(new URL(c.destination).hostname)}</div>` : ''}${c.headline ? `<div class="destination-title">${esc(c.headline)}</div>` : ''}${c.description ? `<div class="description">${esc(c.description)}</div>` : ''}</div>${c.destinationState === 'unsupported_map' && c.cta ? `<span class="cta" aria-disabled="true">${esc(c.cta)}</span>` : c.destination && c.cta ? link(c.destination, c.cta, 'cta') : ''}</div>` : ''}
    </section>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>PostPlus · Ad research</title><style>
*{box-sizing:border-box}body{margin:0;background:#f0f2f5;color:#1c1e21;font:14px/1.45 Arial,Helvetica,sans-serif}header{background:#fff;border-bottom:1px solid #dadde1}header>div,main{max-width:1600px;margin:auto;padding:24px 32px}h1{font-size:28px;letter-spacing:-.8px;margin:8px 0 12px}p{margin:10px 0}.muted,small{color:#65676b}.brands,.filters{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}button,input,select{font:inherit;padding:10px 14px;border:1px solid #ccd0d5;border-radius:6px;background:#fff;color:inherit}button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px}button:hover{background:#f0f2f5}button[aria-pressed=true]{border-color:#1877f2;background:#e7f0fd;color:#165dc0}input{flex:1;min-width:180px}:focus-visible{outline:3px solid #1877f2;outline-offset:3px}.logo{width:36px;height:36px;object-fit:contain;border-radius:50%;flex-shrink:0;border:1px solid #e4e6eb}.missing{display:grid;place-items:center;background:#eee}.brands .logo{width:28px;height:28px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;align-items:start}.card{min-width:0;background:#fff;border:1px solid #d4d6d9;border-radius:8px;padding:16px 12px 12px;box-shadow:0 1px 4px #00000018}.meta{padding:0 4px 16px;font-size:13px;line-height:1.55}.meta p{margin:8px 0}.status{display:inline-flex;align-items:center;gap:5px;padding:0 7px;background:#eceef0;border-radius:12px;font-weight:600;text-transform:capitalize;line-height:20px}.active{background:#e7f1e5;color:#006b50}.inactive{background:#eceef0;color:#65676b}.status-dot{width:12px;height:12px;display:block;flex:none}.status{font-size:12px;height:20px;padding:0 6px;gap:6px}.brands{margin-top:0}.platforms{display:flex;align-items:center;gap:7px;margin:6px 0}.platform-icon{width:14px;height:14px;color:#45484b}.checked{font-size:11px;color:#65676b;margin-top:7px}.collation{font-size:14px}.creative-controls{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;border-radius:6px;background:#f0f2f5;padding:5px 8px}.creative-controls button{padding:2px 10px;border:0;background:transparent;font-size:21px;line-height:25px}.creative-controls output{font-size:12px}.creative-frame{border-top:1px solid #dadde1;padding-top:16px}.variant{border:1px solid #dadde1;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px #00000012}.identity{display:flex;gap:8px;align-items:center;padding:12px 10px 8px}.identity strong{font-size:14px;line-height:18px}.sponsored{display:block;color:#65676b;font-size:12px;line-height:16px;font-weight:600}.copy{padding:0 10px 10px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.4}.media{background:#f0f2f5}.media img,.media video{display:block;width:100%;height:280px;object-fit:contain;margin:auto}.media>*+*{border-top:2px solid #fff}.destination{display:flex;align-items:center;gap:10px;padding:10px;background:#fff;min-height:58px}.destination-copy{flex:1;min-width:0;overflow-wrap:anywhere}.domain{text-transform:uppercase;color:#65676b;font-size:10px;line-height:1.4;margin-bottom:2px}.destination-title{font-size:12px;line-height:1.4}.description{color:#65676b;font-size:11px;line-height:1.45;margin-top:3px}.cta{flex-shrink:0;background:#f0f2f5;border-radius:6px;color:#1c1e21;text-decoration:none;padding:10px 14px;font-size:14px;line-height:20px;max-width:45%;text-align:center;overflow-wrap:anywhere}.cta:hover{background:#e4e6eb}.source{margin:10px 4px 0;font-size:11px}.source a{color:#65676b;text-decoration:none}.source a:hover{text-decoration:underline}.counts{margin:0 0 18px;font-size:16px;font-weight:600}.notice{border:1px solid #d6dce1;background:#fff;padding:12px;border-radius:6px}.sources{margin-top:36px;overflow-wrap:anywhere}.sources h2{font-size:18px}[hidden]{display:none!important}@media(min-width:1450px){.media img,.media video{height:320px}}@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}header>div,main{padding:20px}}@media(max-width:600px){.grid{grid-template-columns:minmax(0,1fr)}header>div,main{padding:16px}.filters>*{width:100%}.media img,.media video{height:300px}}
</style></head><body><header><div><nav class="brands" aria-label="Filter by advertiser"><button type="button" aria-pressed="true" data-brand="">All advertisers</button>${brands.map((a) => `<button type="button" aria-pressed="false" data-brand="${esc(a.advertiserId)}">${logo(a)}${esc(a.advertiser)} <small>${ads.filter((b) => b.advertiserId === a.advertiserId).length}</small></button>`).join('')}</nav><div class="filters"><input id="query" type="search" aria-label="Search ad text or advertiser" placeholder="Search ad text or advertiser"><select id="status" aria-label="Observed ad status"><option value="">All statuses</option><option>active</option><option>inactive</option><option>unknown</option></select><select id="media" aria-label="Media type"><option value="">All media</option><option>video</option><option>image</option></select></div></div></header><main><p id="count" class="counts" role="status">${ads.length} ads shown</p><p id="empty" class="notice" ${ads.length ? 'hidden' : ''}>${esc(emptyReportMessage(ads, sources))}</p><div class="grid">${ads.map((a) => `<article class="card" data-ad="${esc(a.id)}" data-group="${esc(reportCreativeGroupKey(a))}" data-brand="${esc(a.advertiserId)}" data-status="${esc(a.status)}" data-media="${esc(a.creatives.flatMap((c) => c.media.map((m) => m.kind)).join(' '))}"><div class="meta"><span class="status ${a.status}"><svg class="status-dot" aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="${a.status === 'active' ? 'M4.2 8.1 6.7 10.5 11.8 5.3' : 'M4.5 8h7'}" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>${a.status}</span><p>Library ID: ${esc(a.id)}</p>${a.start ? `<div>Started running on ${esc(calendarDate(a.start))}</div>` : ''}${a.end && a.status === 'inactive' ? `<div>Source-reported end: ${esc(calendarDate(a.end))}</div>` : ''}${a.platforms.length ? `<div class="platforms"><span>Platforms</span>${a.platforms.map(platform).join('')}</div>` : ''}${a.collatedAds ? `<p class="collation"><strong>${a.collatedAds} ads</strong> use this creative and text</p>` : ''}<div class="checked">Checked: ${esc(a.observed || 'Not provided')}</div>${timingMarkup(a)}${a.creatives.length > 1 ? `<div class="creative-controls" aria-label="Creative variants"><button type="button" data-step="-1" aria-label="Previous creative">‹</button><output aria-live="polite">Creative 1 of ${a.creatives.length}</output><button type="button" data-step="1" aria-label="Next creative">›</button></div>` : ''}</div><div class="creative-frame">${a.creatives.map((c, i) => creative(a, c, i)).join('')}</div><div class="source">${link(a.source, 'View original ad ↗')}</div></article>`).join('')}</div>${sourceNotices.length ? `<div class="sources">${sourceNotices.map((note) => `<p class="notice">${esc(note)}</p>`).join('')}</div>` : ''}</main><script>
const cards=[...document.querySelectorAll('.card')],buttons=[...document.querySelectorAll('[data-brand][aria-pressed]')];let brand='';
const groups=new Map(),selection=new Map();for(const card of cards){card.dataset.search=card.textContent.toLowerCase();const key=card.dataset.group;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(card)}for(const [key,members] of groups){if(members.length<2)continue;for(const card of members){const control=document.createElement('select');control.className='ad-group';control.setAttribute('aria-label','Ads using the same video');control.style.cssText='width:100%;margin-bottom:12px';control.addEventListener('change',()=>{selection.set(key,control.value);filter()});card.prepend(control)}}
function showCreative(card,index){const variants=[...card.querySelectorAll('.variant')];variants.forEach((v,i)=>{v.hidden=i!==index;if(v.hidden)v.querySelectorAll('video').forEach(video=>video.pause())});card.dataset.current=String(index);const output=card.querySelector('.creative-controls output');if(output)output.textContent='Creative '+(index+1)+' of '+variants.length}
cards.forEach(card=>card.querySelectorAll('[data-step]').forEach(button=>button.addEventListener('click',()=>{const length=card.querySelectorAll('.variant').length;showCreative(card,(Number(card.dataset.current||0)+Number(button.dataset.step)+length)%length)})));
function filter(){let count=0;const q=document.getElementById('query').value.toLowerCase(),status=document.getElementById('status').value,media=document.getElementById('media').value;for(const card of cards){card.hidden=!!((brand&&card.dataset.brand!==brand)||(status&&card.dataset.status!==status)||(media&&!card.dataset.media.split(' ').includes(media))||!card.dataset.search.includes(q));if(!card.hidden){count++;const variants=[...card.querySelectorAll('.variant')];const match=variants.findIndex(v=>(!q||v.textContent.toLowerCase().includes(q)||card.querySelector('.meta').textContent.toLowerCase().includes(q))&&(!media||v.querySelector(media==='video'?'video':'.media img')));if(match>=0)showCreative(card,match)}else card.querySelectorAll('video').forEach(v=>v.pause())}let visibleGroups=0;for(const [key,members] of groups){const matching=members.filter(card=>!card.hidden);if(!matching.length)continue;visibleGroups++;const selected=matching.find(card=>card.dataset.ad===selection.get(key))||matching[0];for(const card of members){const control=card.querySelector('.ad-group');if(control&&card===selected){control.hidden=matching.length<2;control.replaceChildren();for(const member of matching){const option=document.createElement('option');option.value=member.dataset.ad;option.textContent='Library ID: '+member.dataset.ad+' · '+member.dataset.status;option.selected=member===selected;control.append(option)}}if(card!==selected){card.hidden=true;card.querySelectorAll('video').forEach(video=>video.pause())}}}document.getElementById('count').textContent=count+' of '+cards.length+' ads · '+visibleGroups+(visibleGroups===1?' card':' cards');document.getElementById('empty').hidden=count!==0}

buttons.forEach(b=>b.addEventListener('click',()=>{brand=b.dataset.brand;buttons.forEach(x=>x.setAttribute('aria-pressed',String(x===b)));filter()}));['query','status','media'].forEach(id=>document.getElementById(id).addEventListener('input',filter));
filter();
</script></body></html>`;
}

export async function runAdLibraryReport(
  args: string[],
  print: (text: string) => void,
): Promise<number> {
  const paths: string[] = [];
  let output = '';
  for (let i = 0; i < args.length; i++) {
    const flag = args[i],
      value = args[++i];
    if (
      !['--input', '--output'].includes(flag ?? '') ||
      !value ||
      value.startsWith('--')
    )
      throw new Error(
        'Use ad-library report --input <json> [--input <json>] --output <report.html>.',
      );
    if (flag === '--input') paths.push(resolve(value));
    else {
      if (output) throw new Error('Duplicate --output');
      output = resolve(value);
    }
  }
  if (!paths.length || !output)
    throw new Error('Report requires --input and --output.');
  if (paths.includes(output))
    throw new Error('Report output must not overwrite an input.');
  const inputs = await Promise.all(
    paths.map(async (path) => ({
      name: basename(path),
      payload: JSON.parse(await readFile(path, 'utf8')) as unknown,
    })),
  );
  const html = appendSavedMediaLinks(
    renderAdReport(inputs),
    inputs,
    (await resolveApiBaseUrlState()).value,
  );
  await mkdir(dirname(output), { recursive: true });
  const temp = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, html, { flag: 'wx', mode: 0o600 });
    await rename(temp, output);
  } finally {
    await rm(temp, { force: true });
  }
  print(
    `${JSON.stringify({ output, ads: normalizeAdReport(inputs).ads.length })}\n`,
  );
  return 0;
}
