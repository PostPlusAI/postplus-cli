import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
const obj = (x: unknown): Row =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Row) : {};
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string =>
  typeof x === "string"
    ? x
    : typeof x === "number" && Number.isSafeInteger(x)
      ? String(x)
      : "";
const esc = (x: unknown) =>
  str(x).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function url(x: unknown, logo = false): string {
  const value = str(x);
  if (!value) return "";
  const parsed = new URL(
    value,
    logo && value.startsWith("/images/ad-library/brands/")
      ? "https://postplus.io"
      : undefined,
  );
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error(
      "Unsafe report URL. Only HTTP(S) without credentials is supported.",
    );
  return parsed.href;
}
const date = (x: unknown) => {
  if (!x) return "";
  const d = new Date(typeof x === "number" ? x * 1000 : str(x));
  return Number.isFinite(d.valueOf())
    ? d.toISOString().replace("T", " ").replace(".000Z", " UTC")
    : "";
};
export type ReportCreative = {
  body: string;
  headline: string;
  description: string;
  destination: string;
  cta: string;
  media: { kind: string; url: string; poster: string }[];
};
export type ReportAd = {
  id: string;
  advertiser: string;
  advertiserId: string;
  logo: string;
  status: string;
  observed: string;
  start: string;
  end: string;
  platforms: string[];
  source: string;
  creatives: ReportCreative[];
};
export type ReportInput = { name: string; payload: unknown };
export function normalizeAdReport(inputs: ReportInput[]) {
  const ads = new Map<string, ReportAd>();
  const sources: {
    name: string;
    state: string;
    count: number | null;
    note: string;
  }[] = [];
  for (const input of inputs) {
    const envelope = obj(input.payload);
    const stored =
      envelope.schemaVersion === 1 && Array.isArray(envelope.items);
    if (!stored && envelope.routeKey !== "facebook-ads-library")
      throw new Error(`Unsupported ad report input: ${input.name}`);
    const state = stored ? "stored snapshots" : str(envelope.status);
    if (!stored && state !== "completed") {
      if (!state) throw new Error(`Missing operation status: ${input.name}`);
      const error = obj(envelope.error);
      sources.push({
        name: input.name,
        state,
        count: null,
        note:
          str(error.message) ||
          str(envelope.error) ||
          "Collection has not completed. This is not evidence of no ads.",
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
          ? "More stored results are available; this input is only one page."
          : data.items.length
            ? ""
            : "No records returned by this collection; this does not prove the advertiser has no ads.",
    });
    for (const value of data.items) {
      const a = obj(value),
        snapshot = obj(a.snapshot),
        brand = obj(arr(a.brands)[0]);
      const id = str(stored ? a.archive_id : a.ad_archive_id);
      if (!id) throw new Error(`Ad is missing its archive ID: ${input.name}`);
      const rawCreatives = stored
        ? [a]
        : arr(snapshot.cards).length
          ? arr(snapshot.cards)
          : [snapshot];
      const creatives = rawCreatives.map((raw) => {
        const c = obj(raw);
        const media: ReportCreative["media"] = [];
        if (stored) {
          for (const m of arr(a.media).map(obj))
            if (["video", "image"].includes(str(m.kind)))
              media.push({ kind: str(m.kind), url: url(m.url), poster: "" });
        } else {
          for (const v of [
            ...arr(c.videos),
            ...(c.video_hd_url || c.video_sd_url ? [c] : []),
          ].map(obj))
            media.push({
              kind: "video",
              url: url(v.video_hd_url || v.video_sd_url),
              poster: url(v.video_preview_image_url),
            });
          for (const i of [
            ...arr(c.images),
            ...(c.original_image_url || c.resized_image_url ? [c] : []),
          ].map(obj))
            media.push({
              kind: "image",
              url: url(i.original_image_url || i.resized_image_url),
              poster: "",
            });
        }
        return {
          body:
            str(obj(c.body).text) ||
            str(c.body) ||
            str(obj(snapshot.body).text) ||
            str(snapshot.body),
          headline: str(c.headline || c.title),
          description: str(c.link_description),
          destination: url(c.link_url),
          cta: str(c.cta_text),
          media,
        };
      });
      const ad: ReportAd = {
        id,
        advertiser:
          str(stored ? brand.name : a.page_name || snapshot.page_name) ||
          "Advertiser not provided",
        advertiserId: str(a.page_id) || str(brand.slug) || id,
        logo: url(
          stored ? brand.logo_url : snapshot.page_profile_picture_url,
          true,
        ),
        status: stored
          ? ["active", "inactive"].includes(str(a.status))
            ? str(a.status)
            : "unknown"
          : a.is_active === true
            ? "active"
            : a.is_active === false
              ? "inactive"
              : "unknown",
        observed: date(a.observed_at || data.fetchedAt),
        start: date(a.delivery_started_at || a.start_date),
        end: date(a.delivery_ended_at || a.end_date),
        platforms: arr(a.publisher_platform || a.publisher_platforms).map(str),
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

export function renderAdReport(inputs: ReportInput[]): string {
  const { ads, sources } = normalizeAdReport(inputs);
  const brands = [...new Map(ads.map((a) => [a.advertiserId, a])).values()];
  const logo = (a: ReportAd) =>
    a.logo
      ? `<img class="logo" src="${esc(a.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : '<span class="logo missing" aria-hidden="true">—</span>';
  const link = (href: string, label: string) =>
    `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>PostPlus · Ad research</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f4f5;color:#24272b;font:15px/1.5 system-ui,sans-serif}header,main{max-width:1440px;margin:auto;padding:28px}header{background:white;border-bottom:1px solid #ddd}h1{font-size:30px;letter-spacing:-1px;margin:8px 0}p{margin:10px 0}.muted,small{color:#63676f}.brands,.filters{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}button,input,select{font:inherit;padding:10px 14px;border:1px solid #ccd0d5;border-radius:7px;background:white;color:inherit}button{cursor:pointer;display:inline-flex;align-items:center;gap:8px}button[aria-pressed=true]{border-color:#263a47;background:#edf2f5}input{flex:1;min-width:180px}:focus-visible{outline:3px solid #3079a7;outline-offset:3px}.logo{width:38px;height:38px;object-fit:contain;border-radius:50%;flex-shrink:0}.missing{display:grid;place-items:center;background:#eee}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:20px;align-items:start}.card{background:white;border:1px solid #d5d8dc;border-radius:9px;overflow:hidden;box-shadow:0 1px 3px #0000000a}.meta{padding:18px;border-bottom:1px solid #e5e5e5;font-size:13px;font-variant-numeric:tabular-nums}.status{display:inline-block;padding:2px 9px;background:#eceef0;border-radius:12px;font-weight:600;text-transform:capitalize}.active{background:#e4f0e7;color:#17644a}.inactive{background:#f0e9e6;color:#79412b}.identity{display:flex;gap:10px;align-items:center;padding:16px}.copy{padding:0 16px 14px;white-space:pre-wrap;overflow-wrap:anywhere}.media{background:#eceef0}.media img,.media video{display:block;width:100%;height:auto;max-height:560px;object-fit:contain}.destination{padding:16px;background:#f8f9fa;overflow-wrap:anywhere}.destination a{display:inline-block;margin-top:8px}a{color:#245979}.variant+.variant{border-top:2px solid #ddd}.variant-label{padding:8px 16px;color:#63676f;font-size:12px}.source{padding:12px 16px;font-size:13px}.counts{margin:20px 0;font-weight:600}.notice{border:1px solid #d6dce1;background:#f8fafb;padding:12px;border-radius:6px}.sources{margin-top:36px;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:600px){header,main{padding:18px}.filters>*{width:100%}}
</style></head><body><header><small>PostPlus / Research evidence</small><h1>Meta ad references</h1><p class="muted">${ads.length} unique ads · ${brands.length} advertisers. Status reflects the last observation, not a live check.</p><nav class="brands" aria-label="Filter by advertiser"><button type="button" aria-pressed="true" data-brand="">All advertisers</button>${brands.map((a) => `<button type="button" aria-pressed="false" data-brand="${esc(a.advertiserId)}">${logo(a)}${esc(a.advertiser)} <small>${ads.filter((b) => b.advertiserId === a.advertiserId).length}</small></button>`).join("")}</nav><div class="filters"><input id="query" type="search" aria-label="Search ad text or advertiser" placeholder="Search ad text or advertiser"><select id="status" aria-label="Observed ad status"><option value="">All statuses</option><option>active</option><option>inactive</option><option>unknown</option></select><select id="media" aria-label="Media type"><option value="">All media</option><option>video</option><option>image</option></select></div></header><main><p id="count" class="counts" role="status">${ads.length} ads shown</p><p id="empty" class="notice" ${ads.length ? "hidden" : ""}>No ads to display. Check collection outcomes below; an empty result does not establish that no ads exist.</p><div class="grid">${ads.map((a) => `<article class="card" data-brand="${esc(a.advertiserId)}" data-status="${esc(a.status)}" data-media="${esc(a.creatives.flatMap((c) => c.media.map((m) => m.kind)).join(" "))}"><div class="meta"><span class="status ${a.status}">${a.status}</span><p>Library ID: ${esc(a.id)}</p><div>Checked: ${esc(a.observed || "Not provided")}</div>${a.start ? `<div>Started running: ${esc(a.start)}</div>` : ""}${a.end ? `<div>Source-reported end: ${esc(a.end)}</div>` : ""}${a.platforms.length ? `<div>Platforms: ${esc(a.platforms.join(", "))}</div>` : ""}</div><div class="identity">${logo(a)}<div><strong>${esc(a.advertiser)}</strong><br><small>Sponsored</small></div></div>${a.creatives.map((c, i) => `<section class="variant">${a.creatives.length > 1 ? `<div class="variant-label">Creative variant ${i + 1} of ${a.creatives.length}</div>` : ""}${c.body ? `<div class="copy">${esc(c.body)}</div>` : ""}<div class="media">${c.media.map((m) => (m.kind === "video" ? `<video controls playsinline preload="none" src="${esc(m.url)}" ${m.poster ? `poster="${esc(m.poster)}"` : ""} aria-label="Video ad by ${esc(a.advertiser)}"></video>` : `<img src="${esc(m.url)}" loading="lazy" alt="Ad creative by ${esc(a.advertiser)}">`)).join("")}</div>${!c.media.length ? '<p class="copy muted">Media not supplied. Open the source to inspect this ad.</p>' : ""}${c.headline || c.description || c.destination ? `<div class="destination"><strong>${esc(c.headline)}</strong><p>${esc(c.description)}</p>${c.destination ? `<small>${esc(new URL(c.destination).hostname)}</small><br>${link(c.destination, c.cta || "Visit destination")}` : ""}</div>` : ""}</section>`).join("")}<div class="source">${link(a.source, "View original ad ↗")}</div></article>`).join("")}</div><section class="sources"><h2>Collection outcomes</h2><p class="muted">Media loads from source URLs when viewed and may expire. The report itself needs no external scripts.</p>${sources.map((s) => `<p class="notice"><strong>${esc(s.name)}</strong> · ${esc(s.state)} · ${s.count === null ? "No completed result" : `${s.count} returned records`}${s.note ? `<br>${esc(s.note)}` : ""}</p>`).join("")}</section></main><script>
const cards=[...document.querySelectorAll('.card')],buttons=[...document.querySelectorAll('[data-brand][aria-pressed]')];let brand='';function filter(){let count=0;const q=document.getElementById('query').value.toLowerCase(),status=document.getElementById('status').value,media=document.getElementById('media').value;for(const card of cards){card.hidden=!!((brand&&card.dataset.brand!==brand)||(status&&card.dataset.status!==status)||(media&&!card.dataset.media.split(' ').includes(media))||!card.textContent.toLowerCase().includes(q));if(!card.hidden)count++;else card.querySelectorAll('video').forEach(v=>v.pause())}document.getElementById('count').textContent=count+' of '+cards.length+' ads shown';document.getElementById('empty').hidden=count!==0}buttons.forEach(b=>b.addEventListener('click',()=>{brand=b.dataset.brand;buttons.forEach(x=>x.setAttribute('aria-pressed',String(x===b)));filter()}));['query','status','media'].forEach(id=>document.getElementById(id).addEventListener('input',filter));
</script></body></html>`;
}

export async function runAdLibraryReport(
  args: string[],
  print: (text: string) => void,
): Promise<number> {
  const paths: string[] = [];
  let output = "";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i],
      value = args[++i];
    if (
      !["--input", "--output"].includes(flag ?? "") ||
      !value ||
      value.startsWith("--")
    )
      throw new Error(
        "Use ad-library report --input <json> [--input <json>] --output <report.html>.",
      );
    if (flag === "--input") paths.push(resolve(value));
    else {
      if (output) throw new Error("Duplicate --output");
      output = resolve(value);
    }
  }
  if (!paths.length || !output)
    throw new Error("Report requires --input and --output.");
  if (paths.includes(output))
    throw new Error("Report output must not overwrite an input.");
  const inputs = await Promise.all(
    paths.map(async (path) => ({
      name: basename(path),
      payload: JSON.parse(await readFile(path, "utf8")) as unknown,
    })),
  );
  const html = renderAdReport(inputs);
  await mkdir(dirname(output), { recursive: true });
  const temp = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, html, { flag: "wx", mode: 0o600 });
    await rename(temp, output);
  } finally {
    await rm(temp, { force: true });
  }
  print(
    `${JSON.stringify({ output, ads: normalizeAdReport(inputs).ads.length })}\n`,
  );
  return 0;
}
