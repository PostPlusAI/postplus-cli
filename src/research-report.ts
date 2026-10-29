import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { resolveApiBaseUrlState } from './local-state.js';
import {
  RESEARCH_ANALYSIS_SCHEMA,
  type ResearchAnalysis,
  validateResearchAnalysis,
} from './research-report-analysis.js';
import {
  RESEARCH_DETAIL_CSS,
  RESEARCH_DETAIL_SCRIPT,
  renderResearchDetail,
} from './research-report-detail.js';
import {
  type ReportInput,
  type ResearchItem,
  type ResearchReport,
  normalizeResearchReport,
  string,
} from './research-report-model.js';
import { appendSavedMediaLinks } from './saved-media-delivery.js';

const esc = (value: unknown) =>
  string(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const anchor = (id: string) => `item-${encodeURIComponent(id)}`;
const link = (url: string, label: string) =>
  url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
    : '<span class="muted">Source URL not returned</span>';
function observedDate(value: string) {
  if (!value) return 'Date not returned';
  const d = new Date(/^\d+$/.test(value) ? Number(value) * 1000 : value);
  return Number.isFinite(d.valueOf()) ? d.toISOString().slice(0, 10) : value;
}
export const TIKTOK_PREVIEW_SCRIPT = String.raw`
  let activePreview=null, researchDetailOpen=false;
  const previewStates=new Map();
  function stopPreview(node,failed){
    const status=node.querySelector('.tk-preview-status');if(status)status.textContent=failed?'Preview unavailable. Open details to continue.':'';
    const state=previewStates.get(node);if(!state)return;previewStates.delete(node);if(state.timer)clearTimeout(state.timer);
    if(activePreview===state)activePreview=null;node.classList.remove('is-playing');node.classList.remove('is-loaded');
    if(state.frame){state.frame.contentWindow?.postMessage({'x-tiktok-player':true,type:'pause'},'https://www.tiktok.com');state.frame.remove();}
    if(state.video){for(const [type,handler] of state.listeners)state.video.removeEventListener(type,handler);state.listeners=[];state.video.pause();state.video.hidden=true;state.video.removeAttribute('src');state.video.load();}
  }
  function startPreview(node){
    if(researchDetailOpen)return null;if(activePreview?.node===node)return activePreview;if(activePreview)stopPreview(activePreview.node,false);
    const state={node,video:node.querySelector('.tk-hover-video'),frame:null,timer:null,listeners:[]};activePreview=state;previewStates.set(node,state);
    const status=node.querySelector('.tk-preview-status');if(status)status.textContent='';
    if(state.video){state.timer=setTimeout(()=>{if(activePreview===state)stopPreview(node,true);},10000);const video=state.video;video.muted=false;const listen=(type,handler,options)=>{video.addEventListener(type,handler,options);state.listeners.push([type,handler]);};
      listen('playing',()=>{if(activePreview===state){clearTimeout(state.timer);state.timer=null;video.hidden=false;if(status)status.textContent='';}},{once:true});
      listen('error',()=>{if(activePreview===state)stopPreview(node,true);},{once:true});
      video.src=video.dataset.src;Promise.resolve(video.play()).then(()=>{if(activePreview!==state&&previewStates.get(node)?.video!==video)video.pause();}).catch(error=>{if(activePreview===state){const blocked=error?.name==='NotAllowedError';stopPreview(node,!blocked);if(blocked&&status)status.textContent='Click to play with sound.';}});
    }else if(node.dataset.embed){const frame=document.createElement('iframe');state.frame=frame;frame.className='tk-embed-frame';frame.title='TikTok preview';frame.allow='autoplay; fullscreen';frame.referrerPolicy='strict-origin-when-cross-origin';frame.addEventListener('error',()=>{if(activePreview===state)stopPreview(node,true);},{once:true});frame.addEventListener('load',()=>{if(activePreview===state){node.classList.add('is-loaded');if(status)status.textContent='';}},{once:true});frame.src=node.dataset.embed;node.querySelector('.tk-cover-link').append(frame);}
    else stopPreview(node,true);return state;
  }
  function stopHiddenPreviews(){document.querySelectorAll('.tk-preview').forEach(node=>{if(node.closest('.card').hidden)stopPreview(node,false);});}
  document.querySelectorAll('.tk-preview').forEach(node=>{
    node.addEventListener('mouseenter',()=>{if(!researchDetailOpen&&typeof window!=='undefined'&&window.matchMedia?.('(hover: hover) and (pointer: fine)').matches)startPreview(node);});
    node.addEventListener('mouseleave',()=>stopPreview(node,false));
  });
  document.addEventListener?.('research-detail-open',()=>{researchDetailOpen=true;document.querySelectorAll('.tk-preview').forEach(node=>stopPreview(node,false));});
  document.addEventListener?.('research-detail-close',()=>{researchDetailOpen=false;});
  if(typeof window!=='undefined'){
    window.addEventListener('message',event=>{const state=activePreview;if(!state?.frame||event.origin!=='https://www.tiktok.com'||event.source!==state.frame.contentWindow||!event.data||event.data['x-tiktok-player']!==true)return;
      if(event.data.type==='onPlayerReady'){state.frame.contentWindow.postMessage({'x-tiktok-player':true,type:'unMute'},'https://www.tiktok.com');state.frame.contentWindow.postMessage({'x-tiktok-player':true,type:'play'},'https://www.tiktok.com');}
      else if(event.data.type==='onStateChange'&&event.data.value===1){clearTimeout(state.timer);state.timer=null;state.node.classList.add('is-playing');const status=state.node.querySelector('.tk-preview-status');if(status)status.textContent='';}
      else if(event.data.type==='onPlayerError'||event.data.type==='onError'){const blocked=event.data.value?.errorCode===3002;stopPreview(state.node,!blocked);if(blocked){const status=state.node.querySelector('.tk-preview-status');if(status)status.textContent='Click to play with sound.';}}
    });
    window.addEventListener('blur',()=>{if(activePreview)stopPreview(activePreview.node,false);});
  }
  document.addEventListener?.('visibilitychange',()=>{if(document.hidden&&activePreview)stopPreview(activePreview.node,false);});
`;

export function tiktokEmbedUrl(item: ResearchItem): string {
  if (
    item.platform !== 'tiktok' ||
    item.kind !== 'content' ||
    item.mediaFormat === 'slideshow' ||
    !item.url
  )
    return '';
  const url = new URL(item.url);
  const match = /^\/@[^/]+\/video\/(\d+)\/?$/.exec(url.pathname);
  if (
    !['www.tiktok.com', 'tiktok.com', 'm.tiktok.com'].includes(url.hostname) ||
    !match
  )
    return '';
  return `https://www.tiktok.com/player/v1/${match[1]}?autoplay=1&muted=0&controls=0&loop=1&description=0&music_info=0`;
}
export function compactLikes(value: number): string {
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}
function card(
  item: ResearchItem,
  analysis?: ResearchAnalysis,
  report?: ResearchReport,
) {
  const finding = analysis?.items.find((row) => row.id === item.id);
  const status = finding?.decision || 'unreviewed';
  const pictures = [...new Set([item.image, ...item.images].filter(Boolean))];
  const media = item.video
    ? `<video controls preload="none" ${item.image ? `poster="${esc(item.image)}"` : ''} src="${esc(item.video)}"></video>`
    : pictures.length
      ? `<img loading="lazy" alt="${esc(item.kind === 'creator' ? `${item.author} profile` : 'Source content preview')}" src="${esc(pictures[0])}">`
      : '<div class="no-preview">Preview not returned<br>Open the original source</div>';
  const tags = [
    ...new Set([
      ...item.tags,
      ...(finding?.topics?.map((topic) => topic.toLowerCase()) || []),
    ]),
  ];
  const attributes = `id="${anchor(item.id)}" class="card${item.platform === 'tiktok' && item.kind === 'content' ? ' tk-card' : ''}" data-kind="${item.kind}" data-platform="${item.platform}" data-decision="${status}" data-likes="${item.metrics.likes ?? -1}" data-tags="${esc(JSON.stringify(tags))}" data-search="${esc([item.author, item.text, finding?.reason, ...tags].join(' ').toLowerCase())}"`;
  const details = `<h2>${esc(item.author ? `@${item.author}` : 'Author not returned')}</h2><p class="text">${esc(item.text || 'Text not returned')}</p><p class="muted">${esc(observedDate(item.date))}</p>${finding ? `<p>${esc(finding.reason)}</p>${finding.evidenceIds?.map((id) => `<a href="#${anchor(id)}" data-evidence="${esc(id)}">View supporting evidence</a>`).join('') || ''}` : ''}<div class="actions">${link(item.url || item.parentUrl, 'Open original ↗')}</div>`;
  if (item.kind === 'comment') {
    return `<article ${attributes}><button type="button" class="comment-row" data-open-detail="${esc(item.id)}">${item.authorAvatar ? `<img class="comment-author-avatar" loading="lazy" alt="" src="${esc(item.authorAvatar)}" data-initial="${esc(item.author.slice(0, 1).toUpperCase())}">` : `<span class="comment-author-avatar ig-avatar-placeholder">${esc(item.author.slice(0, 1).toUpperCase() || '?')}</span>`}<span class="comment-copy"><strong>${esc(item.author || 'Author unavailable')}</strong><span>${esc(item.text)}</span></span><small>${item.metrics.likes === undefined ? '—' : compactLikes(item.metrics.likes)} likes</small></button></article>`;
  }
  if (item.platform === 'instagram' && item.kind === 'content') {
    const heart =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-8.8-5.5-8.8-12A4.9 4.9 0 0 1 12 6a4.9 4.9 0 0 1 8.8 3c0 6.5-8.8 12-8.8 12Z" fill="currentColor"/></svg>';
    const comments =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a9 9 0 0 1-13.4 7.8L3 21l1.6-4.6A9 9 0 1 1 21 11.5Z" fill="currentColor"/></svg>';
    const icon =
      item.mediaFormat === 'carousel'
        ? '<svg class="ig-format" viewBox="0 0 24 24" aria-label="Carousel"><rect x="7" y="3" width="14" height="14" rx="2" fill="none" stroke="white" stroke-width="2"/><rect x="3" y="7" width="14" height="14" rx="2" fill="white"/></svg>'
        : ['video', 'reel'].includes(item.mediaFormat)
          ? '<svg class="ig-format" viewBox="0 0 24 24" aria-label="Video"><rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="white" stroke-width="2"/><path d="M3 8h18M8 3l3 5m4-5 3 5m-8 4 5 3-5 3Z" stroke="white" fill="white"/></svg>'
          : '';
    return `<article ${attributes}><button type="button" data-open-detail="${esc(item.id)}" class="ig-post-link" title="${esc(finding?.reason || item.text)}" aria-label="${esc(item.text || 'Open Instagram post')}">${item.image ? `<img loading="lazy" src="${esc(item.image)}" alt="${esc(item.text.slice(0, 160) || 'Instagram post')}">` : '<span class="no-preview">Preview unavailable</span>'}${icon}<span class="ig-hover-metrics"><span>${heart}<strong>${item.metrics.likes === undefined ? '—' : compactLikes(item.metrics.likes)}</strong></span><span>${comments}<strong>${item.metrics.comments === undefined ? '—' : compactLikes(item.metrics.comments)}</strong></span></span></button></article>`;
  }
  if (item.platform === 'instagram' && item.kind === 'creator') {
    return `<article ${attributes}><a class="ig-creator-row" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" title="${esc(finding?.reason || item.text)}">${item.authorAvatar ? `<img loading="lazy" src="${esc(item.authorAvatar)}" alt="" data-initial="${esc(item.author.slice(0, 1).toUpperCase())}" class="ig-creator-avatar">` : '<span class="ig-creator-avatar ig-avatar-placeholder"></span>'}<span class="ig-creator-copy"><strong>${esc(item.author || 'Account unavailable')}${item.verified ? '<svg class="ig-verified" viewBox="0 0 24 24" aria-label="Verified account"><path d="m12 1 3 2 3.5.5 1.3 3.3L22 10l-1 3.4.1 3.5-3 1.8-2.2 2.7-3.4-.7-3.4.7-2.2-2.7-3-1.8.1-3.5L2 10l2.2-3.2L5.5 3.5 9 3Z" fill="#3897f0"/><path d="m7.5 11.8 3 3 6-6" fill="none" stroke="white" stroke-width="2"/></svg>' : ''}</strong><small>${esc(item.fullName)}${item.fullName && item.metrics.followers !== undefined ? ' · ' : ''}${item.metrics.followers === undefined ? '' : `${compactLikes(item.metrics.followers)} followers`}</small></span></a>${
      finding
        ? `<details class="ig-match"><summary>Why</summary><p>${esc(finding.reason)}</p><ul>${
            analysis?.criteria
              .map((criterion) => {
                const judgement = finding.criteria.find(
                  (row) => row.id === criterion.id,
                );
                return `<li><strong>${esc(criterion.label)}</strong> · ${judgement ? { met: 'Meets', not_met: 'Does not meet', unknown: 'Unknown' }[judgement.status] : 'Unknown'}${judgement?.evidenceIds.map((id) => ` <a href="#${anchor(id)}" data-evidence="${esc(id)}">Evidence</a>`).join('') || ''}</li>`;
              })
              .join('') || ''
          }</ul></details>`
        : ''
    }</article>`;
  }
  if (item.platform === 'tiktok' && item.kind === 'creator') {
    const work = report?.items.find(
      (candidate) =>
        candidate.kind === 'content' &&
        candidate.platform === 'tiktok' &&
        ((item.representativeUrl && candidate.url === item.representativeUrl) ||
          (item.author &&
            candidate.author.toLowerCase() === item.author.toLowerCase())),
    );
    const workUrl = item.representativeUrl || work?.url || '';
    const workButton = work
      ? `<button type="button" class="tk-account-work" data-open-detail="${esc(work.id)}">View post</button>`
      : workUrl
        ? `<a class="tk-account-work" href="${esc(workUrl)}" target="_blank" rel="noopener noreferrer">View post ↗</a>`
        : '';
    return `<article ${attributes}><div class="tk-account-row"><a class="tk-account-profile" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" title="${esc(finding?.reason || item.text)}">${item.authorAvatar ? `<img class="tk-account-avatar" loading="lazy" src="${esc(item.authorAvatar)}" data-initial="${esc(item.author.slice(0, 1).toUpperCase())}" alt="">` : '<span class="tk-account-avatar ig-avatar-placeholder" aria-label="Profile image unavailable">' + esc(item.author.slice(0, 1).toUpperCase()) + '</span>'}<span class="tk-account-copy"><strong>${esc(item.fullName || item.author || 'Account unavailable')}${item.verified ? '<svg class="tk-account-verified" viewBox="0 0 24 24" aria-label="Verified account"><circle cx="12" cy="12" r="10" fill="#20d5ec"/><path d="m7 12 3 3 7-7" fill="none" stroke="white" stroke-width="2.5"/></svg>' : ''}</strong><small>${esc(item.author ? `@${item.author}` : 'Handle unavailable')}</small><span class="tk-account-followers">${item.metrics.followers === undefined ? 'Followers not returned' : `${compactLikes(item.metrics.followers)} followers`}${item.metrics.likes === undefined ? '' : ` · ${compactLikes(item.metrics.likes)} likes`}</span></span></a>${workButton}</div>${finding ? `<details class="tk-account-match"><summary>Why selected</summary><p>${esc(finding.reason)}</p>${finding.evidenceIds?.map((id) => `<a href="#${anchor(id)}" data-evidence="${esc(id)}">Evidence</a>`).join('') || ''}</details>` : ''}</article>`;
  }
  if (item.platform === 'tiktok' && item.kind === 'content') {
    const directVideo = item.mediaFormat === 'slideshow' ? '' : item.video;
    const embed = directVideo ? '' : tiktokEmbedUrl(item);
    const cover = item.image
      ? `<img class="tk-cover" loading="lazy" src="${esc(item.image)}" alt="${esc(item.text.slice(0, 160) || 'TikTok video cover')}">`
      : '<div class="no-preview">Cover unavailable<br>Open original video</div>';
    const preview = directVideo
      ? `<video class="tk-hover-video" data-src="${esc(directVideo)}" preload="none" playsinline loop hidden></video>`
      : '';
    const likes =
      item.metrics.likes === undefined ? '—' : compactLikes(item.metrics.likes);
    return `<article ${attributes}><div class="tk-preview" data-embed="${esc(embed)}">
      <button class="tk-cover-link" type="button" data-open-detail="${esc(item.id)}" aria-label="Open TikTok post details">${cover}${preview}</button>
      <span class="tk-preview-status" role="status"></span>
      <div class="tk-likes" aria-label="${item.metrics.likes === undefined ? 'Likes not returned' : `${item.metrics.likes} likes`}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-8.8-5.5-8.8-12A4.9 4.9 0 0 1 12 6a4.9 4.9 0 0 1 8.8 3c0 6.5-8.8 12-8.8 12Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><strong>${likes}</strong></div>
      ${item.mediaFormat === 'slideshow' ? '<svg class="tk-slideshow-icon" viewBox="0 0 24 24" aria-label="Slideshow"><rect x="7" y="3" width="14" height="14" rx="2" fill="none" stroke="white" stroke-width="2"/><rect x="3" y="7" width="14" height="14" rx="2" fill="white"/></svg>' : ''}
    </div>    <p class="tk-caption">${esc(item.text || 'Caption not returned')}</p><div class="tk-author">${item.authorAvatar ? `<img loading="lazy" src="${esc(item.authorAvatar)}" alt="" data-initial="${esc(item.author.slice(0, 1).toUpperCase())}" class="tk-author-avatar">` : '<span class="tk-author-avatar tk-avatar-placeholder" aria-hidden="true"></span>'}<span>${esc(item.author ? `@${item.author}` : 'Author not returned')}</span></div>
    ${finding ? `<details class="tk-research-details"><summary>Why selected</summary><p>${esc(finding.reason)}</p>${finding.evidenceIds?.map((id) => `<a href="#${anchor(id)}" data-evidence="${esc(id)}">View supporting evidence</a>`).join('') || ''}</details>` : ''}</article>`;
  }
  return `<article ${attributes}><div class="preview ${item.kind === 'creator' ? 'avatar' : ''}">${media}</div><div class="body">${details}</div></article>`;
}
export function renderResearchReport(
  report: ResearchReport,
  analysis?: ResearchAnalysis,
): string {
  const included =
    analysis?.items.filter((item) => item.decision === 'include').length || 0;
  const kinds = [...new Set(report.items.map((item) => item.kind))].filter(
    (kind) =>
      kind !== 'discovery' ||
      !report.items.some((item) => item.kind !== 'discovery'),
  );
  const recommendedIds = new Set(
    analysis?.items
      .filter((item) => item.decision === 'include')
      .map((item) => item.id) || [],
  );
  const recommendedKinds = new Set(
    report.items
      .filter((item) => recommendedIds.has(item.id))
      .map((item) => item.kind),
  );
  const defaultKind =
    recommendedKinds.size === 1 && recommendedKinds.has('creator')
      ? 'creator'
      : kinds.includes('content')
        ? 'content'
        : kinds.includes('creator')
          ? 'creator'
          : kinds[0] || 'content';
  const content = report.items.filter((item) => item.kind === 'content');
  const initialExplore =
    defaultKind === 'content' &&
    content.length > 0 &&
    content.every((item) => item.platform === 'tiktok');
  const tags = new Map<string, number>();
  for (const item of content.filter((item) => item.platform === 'tiktok')) {
    const finding = analysis?.items.find((row) => row.id === item.id);
    for (const tag of new Set([
      ...item.tags,
      ...(finding?.topics?.map((topic) => topic.toLowerCase()) || []),
    ]))
      tags.set(tag, (tags.get(tag) || 0) + 1);
  }
  const relatedTags = [...tags]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([tag]) => tag);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Search results</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f6f5f2;color:#20221f;font:15px/1.5 Arial,sans-serif}header,main{max-width:1500px;margin:auto;padding:28px 32px}header{padding-bottom:0}h1{font-size:30px;letter-spacing:-1px;margin:8px 0}h2{font-size:19px;margin:8px 0}p{margin:8px 0}.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:11px}.muted,small{color:#676b64}.summary{display:flex;gap:24px;flex-wrap:wrap;margin:20px 0}.summary strong{font-size:24px;display:block}.toolbar{display:flex;gap:10px;flex-wrap:wrap;border-top:1px solid #ddd;padding-top:20px}input,select,button{font:inherit;color:inherit;border:1px solid #c8cbc4;background:white;border-radius:5px;padding:9px 12px}input{flex:1;min-width:190px}button{cursor:pointer}button[aria-pressed=true]{background:#283c2f;color:#fff}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}a{color:#285b3b;overflow-wrap:anywhere}:focus-visible{outline:3px solid #739c83;outline-offset:3px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;align-items:start}.card{border:1px solid #dddeda;border-radius:9px;overflow:hidden;background:white;min-width:0;scroll-margin-top:20px}.preview{background:#e9eae5;aspect-ratio:3/4;display:grid;place-items:center}.preview img,.preview video{display:block;width:100%;height:100%;object-fit:contain;max-height:460px}.avatar{aspect-ratio:auto;padding:24px}.avatar img{width:100px;height:100px;object-fit:cover;border-radius:50%}.no-preview{text-align:center;color:#6b7167;padding:20px}.body{padding:16px}.text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:145px;overflow:auto}.copy-id{font-size:11px;max-width:100%;overflow-wrap:anywhere;text-align:left;padding:4px 6px;background:#f5f6f2}.metrics{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;padding:10px 0}.metrics strong{display:block}.badge{display:inline-block;font-size:11px;letter-spacing:0;text-transform:none;padding:2px 6px;background:#ecefe9;border-radius:3px}.include{background:#e0eddf;color:#285b3b}.exclude{background:#f2e3de;color:#7c4f42}.finding{border-top:1px solid #e7e8e2;margin-top:12px;padding-top:12px}.finding p{font-size:13px}.conditions{padding-left:18px;font-size:12px}.conditions li{margin:10px 0}.carousel{display:flex;overflow:auto;gap:8px;margin:10px 0}.carousel img{max-width:90%;height:220px;object-fit:contain}.actions{margin:14px 0}details{font-size:12px;overflow-wrap:anywhere}summary{cursor:pointer;padding:6px 0}.notice{padding:14px 18px;background:white;border:1px solid #ddd;border-radius:7px;margin:12px 0}.sources{margin-top:36px}.sources h2{font-size:22px}.sources pre{white-space:pre-wrap;font-size:12px}.empty{padding:50px;text-align:center}[hidden]{display:none!important}@media(max-width:1200px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}header,main{padding:22px}}@media(max-width:550px){.grid{grid-template-columns:1fr}header,main{padding:16px}.toolbar>*{width:100%}.summary{gap:18px}.preview{max-height:470px}.summary strong{font-size:22px}}
  
  body.tiktok-explore{background:#121212;color:#f5f5f5}.tiktok-explore header,.tiktok-explore main{max-width:1680px;padding-left:38px;padding-right:38px}.tiktok-explore header{padding-top:26px}.tiktok-explore h1{font-size:25px;letter-spacing:-.6px;margin:8px 0 18px}.tiktok-explore .muted,.tiktok-explore small{color:#a4a4a4}.tiktok-explore input,.tiktok-explore select,.tiktok-explore button{background:#1c1c1c;border-color:#363636;color:#eee}.tiktok-explore .tabs button{border:0;background:transparent;padding-left:0;padding-right:24px;color:#aaa}.tiktok-explore .tabs button[aria-pressed=true]{color:#fff;background:transparent}.tiktok-explore .toolbar{border-color:#2c2c2c}.tiktok-explore .notice{background:#1b1b1b;border-color:#333}.tiktok-explore a{color:#eee}.tiktok-explore .grid{grid-template-columns:repeat(6,minmax(0,1fr));gap:22px 16px}.tiktok-explore main{padding-top:18px}.tiktok-explore #count{color:#999;font-size:12px;margin:0 0 16px}.related-tags{display:flex;align-items:center;gap:22px;overflow-x:auto;white-space:nowrap;padding:18px 0 2px;scrollbar-width:thin}.related-tags button{flex:none;background:transparent!important;border:0!important;border-radius:8px;font-size:15px;font-weight:600;padding:9px 8px;color:#c6c6c6!important}.related-tags button[aria-pressed=true]{background:#343434!important;color:white!important;padding-left:17px;padding-right:17px}.tk-card{border:0;border-radius:0;background:#121212;color:#f5f5f5}.tk-preview{position:relative;aspect-ratio:3/4;background:#222;border-radius:9px;overflow:hidden;isolation:isolate}.tk-cover-link{padding:0;border:0!important;border-radius:0;background:transparent!important;cursor:pointer;text-align:left;line-height:inherit;display:block;width:100%;height:100%;color:#aaa}.tk-cover{width:100%;height:100%;object-fit:cover;display:block}.tk-hover-video,.tk-embed-frame{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border:0;pointer-events:none}.tk-embed-frame{opacity:0}.tk-preview.is-loaded .tk-embed-frame,.tk-preview.is-playing .tk-embed-frame{opacity:1}.tk-likes{position:absolute;left:12px;bottom:12px;display:flex;gap:5px;align-items:center;color:white;z-index:2;text-shadow:0 1px 5px #000;pointer-events:none;font-size:16px}.tk-likes svg{width:23px;height:23px;filter:drop-shadow(0 1px 3px #0006)}.tk-preview:after{content:'';position:absolute;inset:60% 0 0;background:linear-gradient(transparent,#0006);pointer-events:none;z-index:1}.tk-slideshow-icon{position:absolute;right:9px;top:9px;width:20px;height:20px;filter:drop-shadow(0 1px 3px #0009)}.tk-author{display:flex;align-items:center;gap:6px;margin:5px 0 4px;min-width:0;font-size:12px;font-weight:600}.tk-author>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tk-author-avatar{height:20px;width:20px;border-radius:50%;object-fit:cover;flex:none}.tk-avatar-placeholder{background:#414141}.tk-caption{font-size:12px;line-height:1.4;margin:8px 0 4px;color:#eee;display:block;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.tk-preview-status{position:absolute;inset:12px 8px auto;z-index:3;pointer-events:none;font-size:11px;line-height:1.3;color:white;background:#000b;border-radius:4px;padding:6px 8px;text-align:center}.tk-preview-status:empty{display:none}.tk-research-details{margin-top:7px;color:#aaa}.tk-research-details>summary{font-size:11px}.tk-research-details[open]{background:#1d1d1d;border:1px solid #333;border-radius:6px;padding:10px}.tk-research-details .text{color:#eee}.tk-research-details .copy-id{background:#292929;color:#ddd;border-color:#444}.tk-research-details .badge{background:#333;color:#ddd}.tk-research-details .finding{border-color:#3b3b3b}.report-overview{margin:8px 0 14px}.report-overview>summary{font-size:12px;color:#999}.tiktok-explore .report-overview .summary strong{font-size:19px}.tiktok-explore .report-overview .summary{gap:24px;margin:12px 0}@media(max-width:1099px){.tiktok-explore .grid{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:799px){.tiktok-explore .grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:599px){.tiktok-explore .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.tiktok-explore header,.tiktok-explore main{padding-left:18px;padding-right:18px}.related-tags{gap:14px}.tiktok-explore .toolbar>*{width:auto;min-width:0}.tiktok-explore .toolbar input{width:100%;flex-basis:100%}}@media(max-width:380px){.tiktok-explore .grid{gap:22px 10px}.tk-likes{left:8px;font-size:13px}.tk-author{font-size:12px}.tk-author-avatar{height:20px;width:20px}}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}header:has(.tabs:empty){padding-top:18px}.tabs:empty{display:none}.toolbar{border-top:0;padding-top:0}.tiktok-explore .toolbar{border:0}.tiktok-explore header{padding-top:20px}.tiktok-explore main{padding-top:22px}.instagram-native{background:#0b1014;color:#f5f5f5}.instagram-native header{max-width:950px;padding:20px 0 18px}.instagram-native main{max-width:950px;padding:0}.instagram-native .toolbar input,.instagram-native .toolbar select{background:#192229;border-color:#263039;color:#eee}.instagram-native .tabs button{border:0;background:transparent;color:#aaa}.instagram-native .tabs button[aria-pressed=true]{background:#263039;color:white}.instagram-native .tabs{justify-content:center}.instagram-native[data-view="content"] .grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:2px}.instagram-native .card[data-kind="content"]{border:0;border-radius:0;background:#172028;aspect-ratio:3/4}.ig-post-link{padding:0;border:0;border-radius:0;background:transparent;cursor:pointer;text-align:left;line-height:inherit;display:block;width:100%;height:100%;position:relative;color:white;overflow:hidden}.ig-post-link>img{width:100%;height:100%;object-fit:cover;display:block}.ig-format{position:absolute;right:13px;top:13px;width:24px;height:24px;filter:drop-shadow(0 1px 4px #0006)}.ig-hover-metrics{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:25px;background:#0008;opacity:0;transition:opacity .15s}.ig-post-link:hover .ig-hover-metrics,.ig-post-link:focus-visible .ig-hover-metrics{opacity:1}.ig-hover-metrics>span{display:flex;align-items:center;gap:7px;font-size:16px}.ig-hover-metrics svg{height:23px;width:23px}.instagram-native[data-view="creator"] main,.instagram-native[data-view="creator"] header{max-width:500px}.instagram-native[data-view="creator"] .grid{display:flex;flex-direction:column;gap:0}.instagram-native .card[data-kind="creator"]{border:0;background:transparent;border-radius:0}.ig-match>summary{position:absolute;right:8px;top:22px;font-size:11px;color:#8c969f}.ig-match[open]{padding:0 10px 10px 73px;font-size:12px;color:#aeb5ba}.ig-match ul{padding-left:16px}.ig-match li{margin:8px 0}.ig-match a{color:#77a7d6}.instagram-native .card[data-kind="creator"]{position:relative}.ig-creator-row{display:flex;gap:13px;align-items:center;text-decoration:none;color:#f5f5f5;padding:12px 10px;border-radius:6px}.ig-creator-row:hover{background:#152028}.ig-creator-avatar{width:50px;height:50px;object-fit:cover;border-radius:50%;flex:none}.ig-avatar-placeholder{background:#263039;display:inline-grid;place-items:center;font-size:18px;font-weight:600;color:#bbc4cc}.ig-creator-copy{display:flex;min-width:0;flex-direction:column;gap:2px}.ig-creator-copy strong{font-size:14px;display:flex;align-items:center;gap:5px;line-height:20px}.ig-creator-copy small{font-size:13px;color:#959da4}.ig-verified{width:16px;height:16px}.instagram-native .empty{color:#aab1b6}@media(max-width:1000px){.instagram-native header{padding-left:14px;padding-right:14px}.instagram-native[data-view="creator"] main{padding-left:14px;padding-right:14px}}@media(max-width:550px){.instagram-native[data-view="content"] .grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:2px}.ig-hover-metrics{gap:9px}.ig-hover-metrics>span{font-size:11px;gap:4px}.ig-hover-metrics svg{width:16px;height:16px}.ig-format{width:18px;height:18px;top:8px;right:8px}}
  body.tiktok-accounts{background:#121212;color:#f5f5f5}.tiktok-accounts header,.tiktok-accounts main{max-width:700px;padding:18px 20px}.tiktok-accounts main{padding-top:4px}.tiktok-accounts .grid{display:flex;flex-direction:column;gap:0}.tiktok-accounts .card{border:0;border-radius:0;background:transparent;position:relative}.tiktok-accounts input,.tiktok-accounts select{background:#202020;border-color:#333;color:#eee}.tiktok-accounts .tabs button{background:transparent;color:#aaa;border:0}.tiktok-accounts .tabs button[aria-pressed=true]{color:white;background:#333}.tk-account-row{display:flex;align-items:center;gap:15px;min-height:98px;padding:15px 4px}.tk-account-profile{display:flex;gap:13px;align-items:center;color:#f5f5f5;text-decoration:none;flex:1;min-width:0}.tk-account-avatar{width:64px;height:64px;object-fit:cover;border-radius:50%;flex:none}.tk-account-copy{display:flex;flex-direction:column;gap:2px;min-width:0}.tk-account-copy strong{font-size:15px;display:flex;align-items:center;gap:5px;line-height:20px}.tk-account-copy small{font-size:13px;color:#a6a6a6}.tk-account-followers{font-size:12px;color:#aaa}.tk-account-verified{width:16px;height:16px}.tk-account-work{font-size:12px;color:#ccc!important;background:transparent!important;border:1px solid #444!important;padding:7px 10px;text-decoration:none;border-radius:5px;white-space:nowrap}.tk-account-match{font-size:12px;color:#aaa;margin:-5px 0 9px 81px}.tk-account-match summary{font-size:11px}.tk-account-match p{margin:5px 0}.tiktok-accounts .empty{color:#aaa}
  .comment-row{display:flex;align-items:flex-start;gap:12px;width:100%;padding:14px 4px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.comment-author-avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;flex:none}.comment-copy{display:flex;flex:1;flex-direction:column;gap:5px;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.comment-copy strong{font-size:13px}.comment-row small{font-size:11px;white-space:nowrap;color:#888}body[data-view="comment"] header,body[data-view="comment"] main{max-width:760px}body[data-view="comment"] .grid{display:flex;flex-direction:column;gap:0}body[data-view="comment"] .card{border:0;background:transparent}
  ${RESEARCH_DETAIL_CSS}</style></head><body data-view="${defaultKind}"${initialExplore ? ' class="tiktok-explore"' : report.items.length > 0 && report.items.every((item) => item.platform === 'instagram') ? ' class="instagram-native"' : defaultKind === 'creator' && report.items.some((item) => item.kind === 'creator') && report.items.filter((item) => item.kind === 'creator').every((item) => item.platform === 'tiktok') ? ' class="tiktok-accounts"' : ''}><header><nav class="tabs" aria-label="Result view">${kinds.length > 1 ? kinds.map((kind) => `<button type="button" data-view="${kind}" aria-pressed="${kind === defaultKind}">${{ content: content.length > 0 && content.every((item) => item.platform === 'tiktok') ? 'Videos' : 'Posts', creator: 'Accounts', comment: 'Comments', discovery: 'Discover' }[kind]}</button>`).join('') : ''}</nav>
  <div class="toolbar"><input id="query" type="search" aria-label="Search" placeholder="Search">${new Set(report.items.map((item) => item.platform)).size > 1 ? '<select id="platform" aria-label="Platform"><option value="">All platforms</option><option value="instagram">Instagram</option><option value="tiktok">TikTok</option></select>' : `<input type="hidden" id="platform" value="${report.items[0]?.platform || ''}">`}<select id="decision" aria-label="Results"><option value="">All</option><option value="include"${included ? ' selected' : ''}>Recommended</option></select><select id="sort" aria-label="Sort results"><option value="source">Default</option><option value="likes">Most liked</option></select></div><nav id="related-tags" class="related-tags" aria-label="Related topics"${initialExplore ? '' : ' hidden'}><button type="button" data-tag="" aria-pressed="true">All</button>${relatedTags.map((tag) => `<button type="button" data-tag="${esc(tag)}" aria-pressed="false">${esc(tag)}</button>`).join('')}</nav></header>
  <main><p id="count" class="sr-only" role="status" aria-live="polite"></p><div id="grid" class="grid">${report.items.map((item) => card(item, analysis, report)).join('')}</div><p class="empty" id="empty" hidden>No results match these filters.</p>
</main>${renderResearchDetail(report, analysis)}
  <script>
  const cards=[...document.querySelectorAll('.card')], grid=document.getElementById('grid');let view=${JSON.stringify(defaultKind)},selectedTag="";cards.forEach((card,i)=>card.dataset.order=String(i));
  function update(){const q=document.getElementById('query').value.toLowerCase(),platform=document.getElementById('platform').value,decision=document.getElementById('decision').value;let n=0;cards.forEach(card=>{card.hidden=Boolean(card.dataset.kind!==view||(platform&&card.dataset.platform!==platform)||(decision&&card.dataset.decision!==decision)||(q&&!card.dataset.search.includes(q))||(selectedTag&&!JSON.parse(card.dataset.tags||'[]').includes(selectedTag)));if(!card.hidden)n++});document.getElementById('count').textContent=n+' results shown';document.getElementById('empty').hidden=n!==0;const contentCards=cards.filter(card=>card.dataset.kind==='content');const explore=view==='content'&&(platform==='tiktok'||(!platform&&contentCards.length>0&&contentCards.every(card=>card.dataset.platform==='tiktok')));if(document.body){document.body.classList.toggle('tiktok-explore',explore);document.body.classList.toggle('instagram-native',platform==='instagram'||(!platform&&cards.length>0&&cards.every(card=>card.dataset.platform==='instagram')));document.body.classList.toggle('tiktok-accounts',view==='creator'&&(platform==='tiktok'||(!platform&&cards.filter(card=>card.dataset.kind==='creator').every(card=>card.dataset.platform==='tiktok'))));document.body.dataset.view=view;}const tagBar=document.getElementById('related-tags');if(tagBar)tagBar.hidden=!explore;document.querySelectorAll('[data-tag]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.tag===selectedTag)));if(typeof stopHiddenPreviews==='function')stopHiddenPreviews();document.querySelectorAll('.tabs button[data-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.view===view)))}
  document.querySelectorAll('[data-tag]').forEach(button=>button.addEventListener('click',()=>{selectedTag=button.dataset.tag;update()}));
  document.querySelectorAll('.tabs button[data-view]').forEach(button=>button.addEventListener('click',()=>{view=button.dataset.view;selectedTag='';const decision=document.getElementById('decision');if(decision.value==='include'&&!cards.some(card=>card.dataset.kind===view&&card.dataset.decision==='include'))decision.value='';update()}));document.querySelectorAll('input,select').forEach(el=>el.addEventListener('input',()=>{if(el.id==='platform')selectedTag='';if(el.id==='sort'){cards.sort((a,b)=>el.value==='likes'?Number(b.dataset.likes)-Number(a.dataset.likes):Number(a.dataset.order)-Number(b.dataset.order)).forEach(card=>grid.append(card))}update()}));
  document.querySelectorAll('.copy-id').forEach(button=>button.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(button.dataset.id);button.textContent='Copied: '+button.dataset.id}catch{button.textContent='Select and copy: '+button.dataset.id}}));
  document.querySelectorAll('[data-evidence]').forEach(link=>link.addEventListener('click',()=>{const target=document.getElementById('item-'+encodeURIComponent(link.dataset.evidence));if(target){view=target.dataset.kind;document.getElementById('query').value='';document.getElementById('platform').value='';document.getElementById('decision').value='';selectedTag='';update();target.scrollIntoView()}}));
  function unavailableMedia(media){if(media.dataset.reportUnavailable==='true'||media.classList.contains('tk-hover-video'))return;media.dataset.reportUnavailable='true';if(media.classList.contains('ig-creator-avatar')||media.classList.contains('tk-author-avatar')||media.classList.contains('tk-account-avatar')||media.classList.contains('comment-author-avatar')){const placeholder=document.createElement('span');placeholder.className=media.className+' ig-avatar-placeholder';placeholder.setAttribute('role','img');placeholder.setAttribute('aria-label','Profile image unavailable');placeholder.textContent=media.dataset.initial||'?';media.replaceWith(placeholder);return;}media.hidden=true;const note=document.createElement('span');note.className='no-preview';note.textContent='Preview unavailable';media.after(note);}
  document.querySelectorAll('#grid img,#grid video').forEach(media=>{media.addEventListener('error',()=>unavailableMedia(media),{once:true});if(media.tagName==='IMG'&&media.complete&&media.naturalWidth===0)unavailableMedia(media);});${TIKTOK_PREVIEW_SCRIPT}update();${RESEARCH_DETAIL_SCRIPT}
  </script></body></html>`;
}
const usage =
  'postplus research report --input <result.json> [--input <result.json>] [--analysis <findings.json>] --output <research.html>';
export async function runResearchReport(
  args: string[],
  print: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    print(
      `${usage}\npostplus research report --analysis-schema\nLocal evidence report. No login, credits, network calls, or feedback storage.\n`,
    );
    return 0;
  }
  if (args.length === 1 && args[0] === '--analysis-schema') {
    print(`${JSON.stringify(RESEARCH_ANALYSIS_SCHEMA, null, 2)}\n`);
    return 0;
  }
  const paths: string[] = [];
  let output = '',
    analysisPath = '';
  for (let i = 0; i < args.length; i++) {
    const flag = args[i],
      value = args[++i];
    if (
      !['--input', '--analysis', '--output'].includes(flag || '') ||
      !value ||
      value.startsWith('--')
    )
      throw new Error(`Use ${usage}`);
    const path = resolve(value);
    if (flag === '--input') {
      if (paths.includes(path)) throw new Error('Duplicate --input');
      paths.push(path);
    } else if (flag === '--analysis') {
      if (analysisPath) throw new Error('Duplicate --analysis');
      analysisPath = path;
    } else {
      if (output) throw new Error('Duplicate --output');
      output = path;
    }
  }
  if (!paths.length || !output) throw new Error(`Use ${usage}`);
  if (paths.includes(output) || output === analysisPath)
    throw new Error(
      'Report output must not overwrite raw evidence or analysis.',
    );
  const inputs: ReportInput[] = await Promise.all(
    paths.map(async (path) => ({
      name: path,
      payload: JSON.parse(await readFile(path, 'utf8')) as unknown,
    })),
  );
  const report = normalizeResearchReport(inputs),
    analysis = analysisPath
      ? validateResearchAnalysis(
          JSON.parse(await readFile(analysisPath, 'utf8')),
          report.items,
        )
      : undefined;
  const html = appendSavedMediaLinks(
    renderResearchReport(report, analysis),
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
    `${JSON.stringify({ output, returned: report.returned, unique: report.items.length, reviewed: analysis?.items.length || 0, items: report.items.map((item) => ({ id: item.id, kind: item.kind, url: item.url, author: item.author, sources: item.sources })) })}\n`,
  );
  return 0;
}
