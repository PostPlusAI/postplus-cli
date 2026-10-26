import { createHash } from 'node:crypto';

import type { ResearchAnalysis } from './research-report-analysis.js';
import type { ResearchItem, ResearchReport } from './research-report-model.js';
import { safeUrl } from './research-report-model.js';

function canonical(value: string): string {
  if (!value) return '';
  const checked = safeUrl(value);
  if (!checked) return '';
  const url = new URL(checked);
  const host = url.hostname.replace(/^www\./, '');
  const tiktokId = /^\/@[^/]+\/(?:video|photo)\/(\d+)\/?$/.exec(
    url.pathname,
  )?.[1];
  const instagramId = /^\/(?:p|reel|reels)\/([^/]+)\/?$/.exec(
    url.pathname,
  )?.[1];
  if (['tiktok.com', 'm.tiktok.com'].includes(host) && tiktokId)
    return `tiktok:post:${tiktokId}`;
  if (['instagram.com', 'm.instagram.com'].includes(host) && instagramId)
    return `instagram:post:${instagramId}`;
  url.search = '';
  url.hash = '';
  url.hostname = host;
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}
/** TikTok's official player accepts a real post ID, never a guessed author URL. */
function embed(item: ResearchItem): string {
  if (item.platform !== 'tiktok' || item.video || !item.url) return '';
  const url = new URL(safeUrl(item.url));
  const id = /^\/@[^/]+\/(?:video|photo)\/(\d+)\/?$/.exec(url.pathname)?.[1];
  if (
    !id ||
    !['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(url.hostname)
  )
    return '';
  // muted=1 locks volume at zero according to the official player contract.
  // Opening detail is the user playback action; the browser may still require native Play.
  return `https://www.tiktok.com/player/v1/${id}?autoplay=1&muted=0&controls=1&description=0&music_info=0`;
}
function commentCollectionRequest(
  item: ResearchItem,
  sourceNames: string[],
): string {
  const url = safeUrl(item.url);
  if (!url || new URL(url).protocol !== 'https:') return '';
  const native =
    /^(?:tiktok|instagram):post:(.+)$/.exec(canonical(url))?.[1] ||
    createHash('sha256').update(item.id).digest('hex').slice(0, 16);
  const filename = `comments-${native.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const command = `postplus research run ${item.platform}-comments --url ${quote(url)} --limit 100${item.platform === 'tiktok' ? ' --include-replies true' : ''} --wait --output ${quote(filename)}`;
  return `Use the ${item.platform === 'instagram' ? 'instagram-research' : 'tiktok-research'} skill to collect up to 100 comments for the post below. ${item.platform === 'tiktok' ? 'Include supported replies within the same 100-comment total, with at most 5 replies per parent comment. ' : ''}Keep comments linked to their original post and reuse comments already collected.

Original post:
${url}

Executable CLI command:
${command}

Original source batches for this report:
${sourceNames.join('\n')}

After collection, regenerate this same research report using the new JSON together with the original source batches, so this post's detail shows the real comments. Keep the existing research judgments and filters (if findings.json exists, continue passing --analysis). Only add comments; do not create a separate comments-only page. Report any failure instead of inventing results.`;
}

export function renderResearchDetail(
  report: ResearchReport,
  _analysis?: ResearchAnalysis,
): string {
  const content = report.items.filter((item) => item.kind === 'content');
  const contexts = new Set<string>();
  const known = new Set(
    content.map((item) => `${item.platform}:${canonical(item.url)}`),
  );
  for (const comment of report.items.filter(
    (item) => item.kind === 'comment' && item.parentUrl,
  )) {
    const key = `${comment.platform}:${canonical(comment.parentUrl)}`;
    if (known.has(key)) continue;
    known.add(key);
    const id = `context:${key}`;
    contexts.add(id);
    content.push({
      ...comment,
      id,
      kind: 'content',
      author: '',
      fullName: '',
      verified: false,
      text: '',
      url: comment.parentUrl,
      image: '',
      video: '',
      images: [],
      mediaFormat: 'unknown',
      metrics: {},
      parentUrl: '',
    });
  }
  const posts = content.map((item) => {
    const key = canonical(item.url);
    const comments = report.items.filter(
      (row) =>
        row.kind === 'comment' &&
        row.platform === item.platform &&
        canonical(row.parentUrl) === key &&
        key,
    );
    const sources = report.sources.filter(
      (source) =>
        source.route === `${item.platform}-comments` &&
        [
          source.input.urls,
          source.route === 'tiktok-comments'
            ? source.input.postURLs
            : source.input.directUrls,
        ]
          .flatMap((urls) => (Array.isArray(urls) ? urls : []))
          .some(
            (url) => typeof url === 'string' && canonical(url) === key && key,
          ),
    );
    const empty = sources.some((source) => source.status === 'completed');
    const state = comments.length
      ? 'collected'
      : empty
        ? 'empty'
        : sources.some((source) => source.status === 'failed')
          ? 'failed'
          : sources.some((source) => source.status !== 'completed')
            ? 'pending'
            : sources.length
              ? 'unmatched'
              : 'not-collected';
    return {
      id: item.id,
      platform: item.platform,
      author: item.author,
      caption: item.text,
      url: safeUrl(item.url),
      image: safeUrl(item.image),
      video: safeUrl(item.video),
      embed: contexts.has(item.id) ? '' : embed(item),
      mediaCollected: !contexts.has(item.id),
      images: [
        ...new Set(
          (item.mediaFormat === 'carousel' && item.images.length
            ? item.images
            : [item.image, ...item.images]
          )
            .filter(Boolean)
            .map(safeUrl),
        ),
      ],
      format: item.mediaFormat,
      metrics: item.metrics,
      commentsState: state,
      collectionRequest:
        state === 'not-collected'
          ? commentCollectionRequest(
              item,
              report.sources.map((source) => source.name),
            )
          : '',
      collectionNote: sources.some((source) => source.status === 'failed')
        ? 'A comment collection request failed; existing collected evidence is retained.'
        : sources.some((source) => source.status !== 'completed')
          ? 'A comment collection request is still processing.'
          : '',
      comments: comments.map((comment) => ({
        id: comment.id,
        parentCommentId:
          'parentCommentId' in comment &&
          typeof comment.parentCommentId === 'string'
            ? comment.parentCommentId
            : '',
        author: comment.author,
        avatar: safeUrl(comment.authorAvatar),
        text: comment.text,
        date: comment.date,
        likes: comment.metrics.likes,
      })),
    };
  });
  const json = JSON.stringify({ posts })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<dialog id="research-detail" data-detail-version="native-audible-v5" class="rd-dialog" aria-labelledby="rd-title"><button type="button" class="rd-close" id="rd-close" aria-label="Close detail">×</button><div class="rd-layout"><section class="rd-media-pane" aria-label="Post media"><div id="rd-media" class="rd-media"></div><nav class="rd-post-nav" aria-label="Post navigation"><button type="button" id="rd-prev" aria-label="Previous post"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><button type="button" id="rd-next" aria-label="Next post"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></nav></section><section class="rd-discussion"><header class="rd-header"><strong id="rd-title"></strong><a id="rd-original" target="_blank" rel="noopener noreferrer">Open original ↗</a></header><p id="rd-caption" class="rd-caption"></p><h2 id="rd-comments-title">Collected comments</h2><div id="rd-comments" class="rd-comments"></div></section></div></dialog><script type="application/json" id="research-detail-data">${json}</script>`;
}

export const RESEARCH_DETAIL_CSS = String.raw`
.rd-dialog{padding:0;border:1px solid #30363b;border-radius:10px;background:#101619;color:#f5f5f5;width:min(1200px,94vw);max-width:94vw;height:min(880px,92vh);height:min(880px,92dvh);max-height:92vh;max-height:92dvh;overflow:hidden}.rd-dialog::backdrop{background:#000d}.rd-layout{position:absolute;inset:0;width:100%;max-height:100%;max-width:100%;display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr);grid-template-rows:minmax(0,1fr);height:100%;min-height:0}.rd-close{position:absolute;right:10px;top:8px;z-index:5;border:0;background:#171d22dd;color:white;border-radius:50%;width:34px;height:34px;font-size:25px;cursor:pointer}.rd-media-pane{position:relative;min-width:0;min-height:0;overflow:hidden;background:#050607;height:100%;width:100%;display:block}.rd-media{position:absolute;inset:0;width:100%;height:100%;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden}.rd-media>video,.rd-media>iframe,.rd-media>img{position:absolute;inset:0;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;object-position:center;min-width:0;min-height:0;border:0}.rd-post-nav{position:absolute;right:14px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:12px;z-index:3}.rd-post-nav button{width:40px;height:40px;min-width:40px;min-height:40px;flex:none;box-sizing:border-box;display:grid;place-items:center;padding:0;margin:0;line-height:0;appearance:none;transform:none;border:0;border-radius:50%;background:#252a30c9;color:white;cursor:pointer}.rd-post-nav button:hover{background:#3b424b}.rd-post-nav button:disabled{opacity:.3;cursor:default}.rd-post-nav svg{display:block;transform-origin:50% 50%;width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}#rd-prev svg{transform:rotate(180deg)}.rd-play-hint{position:absolute;top:12px;left:12px;right:58px;margin:0;padding:7px 10px;background:#101619c9;color:#d1d8dd;font-size:12px;border-radius:4px;pointer-events:none}.rd-player-error{position:absolute;left:12px;bottom:12px;margin:0;padding:8px 12px;background:#101619dd;color:#d1d8dd;font-size:12px;border-radius:4px}.rd-carousel-nav button{border:1px solid #424a50;background:#20282d;color:white;padding:7px 11px;border-radius:5px;cursor:pointer}.rd-discussion{min-width:0;min-height:0;overflow:auto;background:#11181c;border-left:1px solid #293136;padding:20px}.rd-discussion .rd-header{padding:10px 30px 14px 0;margin:0;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px}.rd-header a{font-size:12px;color:#91caff;white-space:nowrap}.rd-caption{font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}.rd-discussion h2{font-size:13px;font-weight:600;color:#aab4bb;border-top:1px solid #30383d;padding-top:18px;margin-top:20px}.rd-comment{padding:13px 0;font-size:13px;line-height:1.45}.rd-comment-avatar{width:28px;height:28px;border-radius:50%;object-fit:cover;float:left;margin:0 9px 4px 0}.rd-comment-highlight{background:#223845;border-radius:6px;outline:1px solid #56849f;padding-left:8px;padding-right:8px}.rd-comment>strong{display:block;font-size:13px}.rd-comment>p{white-space:pre-wrap;overflow-wrap:anywhere;margin:5px 0}.rd-comment small,.rd-comment-note{color:#9da9b2;font-size:12px}.rd-comment details{margin-top:8px;padding-left:14px;border-left:1px solid #33414a}.rd-comment summary{cursor:pointer;color:#9bcaf2;font-size:12px}.rd-comment-note{padding:18px 0}.rd-collect-request{display:inline-block;margin:4px 0 0;padding:9px 14px;background:#253b49;color:#d8efff;border:1px solid #4a6b80;border-radius:6px;cursor:pointer}.rd-collection-request{display:block;width:100%;min-height:180px;margin:10px 0;background:#172127;color:#d8e1e6;border:1px solid #405461;border-radius:5px;padding:10px;font:12px/1.5 monospace;resize:vertical}.rd-carousel-nav{position:absolute;left:0;right:0;top:50%;display:flex;justify-content:space-between;padding:12px;pointer-events:none}.rd-carousel-nav button{pointer-events:auto}.research-detail-open{overflow:hidden}@media(max-width:700px){.rd-dialog{width:96vw;max-width:96vw;height:94vh;height:94dvh;max-height:94vh;max-height:94dvh}.rd-layout{grid-template-columns:1fr;grid-template-rows:minmax(0,52%) minmax(0,48%)}.rd-discussion{border-left:0;border-top:1px solid #30383d;padding:14px}.rd-discussion .rd-header{padding-top:0}.rd-close{right:8px;top:6px}}
.rd-dialog[data-platform="tiktok"]{background:#121212;border-color:#333}.rd-dialog[data-platform="tiktok"] .rd-discussion{background:#121212;border-color:#333}.rd-dialog[data-platform="tiktok"] .rd-discussion h2{color:#aaa;border-color:#333}.rd-dialog[data-platform="tiktok"] .rd-comment-note,.rd-dialog[data-platform="tiktok"] .rd-comment small{color:#aaa}.rd-dialog[data-platform="tiktok"] .rd-close{background:#252525dd}.rd-dialog[data-platform="tiktok"] .rd-collect-request{background:#252525;color:#f5f5f5;border-color:#3a3a3a}.rd-dialog[data-platform="tiktok"] .rd-collection-request{background:#1b1b1b;color:#ddd;border-color:#3a3a3a}.rd-dialog[data-platform="tiktok"] .rd-comment-highlight{background:#282828;outline-color:#777}

`;

export const RESEARCH_DETAIL_SCRIPT = String.raw`
(()=>{
 const dialog=document.getElementById('research-detail'),dataNode=document.getElementById('research-detail-data');
 if(!dialog||!dataNode)return;
 const posts=JSON.parse(dataNode.textContent).posts;
 const media=document.getElementById('rd-media'),comments=document.getElementById('rd-comments');
 let current=-1,trigger=null,activeVideo=null,activeFrame=null,carousel=0;
 function button(label,action){const node=document.createElement('button');node.type='button';node.textContent=label;node.addEventListener('click',action);return node;}
 function note(parent,text){const node=document.createElement('p');node.className='rd-comment-note';node.textContent=text;parent.append(node);}
 function send(type){if(activeFrame?.contentWindow)activeFrame.contentWindow.postMessage({'x-tiktok-player':true,type},'https://www.tiktok.com');}
 function stop(){if(activeVideo){activeVideo.pause();activeVideo.removeAttribute('src');activeVideo.load();}if(activeFrame){send('pause');activeFrame.remove();}activeVideo=null;activeFrame=null;media.replaceChildren();}
 function failure(text){const old=media.querySelector?.('.rd-player-error');if(old)old.remove();const node=document.createElement('p');node.className='rd-player-error';node.textContent=text+' Open the original post.';media.append(node);}
 function showComments(post){
  comments.replaceChildren();const heading=document.getElementById('rd-comments-title');if(heading)heading.textContent=post.comments.length?'Comments · '+post.comments.length+' collected':'Collected comments';
  if(post.collectionNote)note(comments,post.collectionNote);
  if(!post.comments.length){const messages={'not-collected':'Want to collect comments for this post?','empty':'No comments returned.','failed':'Comment collection failed. Comments unavailable.','pending':'Comment collection is not complete.','unmatched':'No comments returned.'};note(comments,messages[post.commentsState]||'Comments not collected.');if(post.commentsState==='not-collected'&&post.collectionRequest){let manual=null;const copy=button('Copy collection request',async()=>{try{if(typeof navigator==='undefined'||!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(post.collectionRequest);copy.textContent='Copied. Paste this into your agent.';}catch{if(!manual){note(comments,'Automatic copying failed. Select the text below and copy it to your agent.');manual=document.createElement('textarea');manual.className='rd-collection-request';manual.readOnly=true;manual.value=post.collectionRequest;manual.setAttribute('aria-label','Comment collection request and CLI command');comments.append(manual);}manual.focus();manual.select();}});copy.className='rd-collect-request';comments.append(copy);note(comments,'Paste this into your agent to run it. This page will not collect comments itself.');}return;}
  const rows=post.comments,byId=new Map(rows.map(row=>[row.id,row])),native=new Map(rows.map(row=>[row.id.split(':').pop(),row]));
  const parentOf=row=>byId.get(row.parentCommentId)||native.get(row.parentCommentId);
  const children=new Map();rows.forEach(row=>{const parent=parentOf(row);if(parent&&parent!==row){const list=children.get(parent.id)||[];list.push(row);children.set(parent.id,list);}});
  const seen=new Set();
  function append(row,parent){if(seen.has(row.id))return;seen.add(row.id);const node=document.createElement('article');node.className='rd-comment';node.dataset.commentId=row.id;if(row.avatar){const avatar=document.createElement('img');avatar.className='rd-comment-avatar';avatar.alt='';avatar.src=row.avatar;avatar.addEventListener('error',()=>{avatar.hidden=true;},{once:true});node.append(avatar);}const author=document.createElement('strong');author.textContent=row.author?'@'+row.author:'Author not returned';node.append(author);const text=document.createElement('p');text.textContent=row.text;node.append(text);const extra=document.createElement('small');extra.textContent=[row.date,Number.isFinite(row.likes)?row.likes+' likes':''].filter(Boolean).join(' · ');node.append(extra);if(row.parentCommentId&&!parentOf(row)){note(node,'Collected reply; parent comment was not collected.');}const replies=children.get(row.id)||[];if(replies.length){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='View replies ('+replies.length+' collected)';details.append(summary);replies.forEach(reply=>append(reply,details));node.append(details);}parent.append(node);}
  rows.filter(row=>!parentOf(row)).forEach(row=>append(row,comments));rows.forEach(row=>append(row,comments));
 }
 function showImage(post){
  const pictures=post.images.length?post.images:(post.image?[post.image]:[]);
  if(!pictures.length){note(media,'Preview unavailable. Open the original post.');return;}
  const image=document.createElement('img');image.alt='Collected post image';image.src=pictures[carousel];image.addEventListener('error',()=>{image.hidden=true;note(media,'Image unavailable. Open the original post.');},{once:true});media.append(image);
  if(pictures.length>1){const nav=document.createElement('div');nav.className='rd-carousel-nav';const move=delta=>{carousel=(carousel+delta+pictures.length)%pictures.length;media.replaceChildren();showImage(post);};const prev=button('‹',()=>move(-1)),next=button('›',()=>move(1));prev.setAttribute('aria-label','Previous image');next.setAttribute('aria-label','Next image');nav.append(prev,next);media.append(nav);}
 }
 function mount(post){
  stop();carousel=0;
  if(post.mediaCollected===false){note(media,'Post media was not collected. Open the original post.');return;}
  if(post.video){const video=document.createElement('video');activeVideo=video;video.controls=true;video.muted=false;video.playsInline=true;video.preload='metadata';if(post.image)video.poster=post.image;
   let playHint=null;const blocked=()=>{if(activeVideo!==video||!dialog.open||video.error)return;if(!playHint){playHint=document.createElement('p');playHint.className='rd-play-hint';playHint.textContent='Press Play in the player to start.';media.append(playHint);}};video.addEventListener('playing',()=>{if(activeVideo===video&&playHint){playHint.remove();playHint=null;}});video.addEventListener('error',()=>{if(activeVideo===video){if(playHint)playHint.remove();failure('Video preview unavailable.');}});video.src=post.video;media.append(video);try{Promise.resolve(video.play()).catch(blocked);}catch{blocked();}
  }else if(post.embed){const frame=document.createElement('iframe');activeFrame=frame;frame.title='TikTok post player';frame.allow='autoplay; fullscreen';frame.referrerPolicy='strict-origin-when-cross-origin';frame.src=post.embed;media.append(frame);
  }else showImage(post);
 }
 function open(id){let index=posts.findIndex(post=>post.id===id);const commentTarget=index<0?id:null;if(index<0)index=posts.findIndex(post=>post.comments.some(comment=>comment.id===id));if(index<0)return;const wasOpen=dialog.open;if(!wasOpen)trigger=document.activeElement;
  document.dispatchEvent(new CustomEvent('research-detail-open',{detail:{id}}));
  current=index;const post=posts[current];dialog.dataset.platform=post.platform;document.getElementById('rd-title').textContent=post.author?'@'+post.author:post.platform+' post';document.getElementById('rd-caption').textContent=post.caption;const link=document.getElementById('rd-original');link.href=post.url;link.hidden=!post.url;document.getElementById('rd-prev').disabled=current===0;document.getElementById('rd-next').disabled=current===posts.length-1;
  if(!wasOpen)dialog.showModal();document.body.classList.add('research-detail-open');mount(post);showComments(post);if(commentTarget){const target=Array.from(comments.querySelectorAll?.('[data-comment-id]')||[]).find(node=>node.dataset.commentId===commentTarget);if(target){for(let ancestor=target.parentElement;ancestor&&ancestor!==comments;ancestor=ancestor.parentElement){if(ancestor.tagName==='DETAILS')ancestor.open=true;}target.classList.add('rd-comment-highlight');target.scrollIntoView?.({block:'center'});}}if(!wasOpen)document.getElementById('rd-close').focus();
 }
 function close(){if(!dialog.open)return;stop();dialog.close();document.body.classList.remove('research-detail-open');document.dispatchEvent(new CustomEvent('research-detail-close'));if(trigger?.isConnected)trigger.focus();trigger=null;}
 window.openResearchDetail=open;
 document.getElementById('rd-close').addEventListener('click',close);
 dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}});
 document.getElementById('rd-prev').addEventListener('click',()=>{if(current>0)open(posts[current-1].id);});
 document.getElementById('rd-next').addEventListener('click',()=>{if(current+1<posts.length)open(posts[current+1].id);});
 document.addEventListener('click',event=>{const target=event.target.closest?.('[data-open-detail]');if(target){event.preventDefault();open(target.dataset.openDetail);}});
 window.addEventListener('message',event=>{if(!activeFrame||event.origin!=='https://www.tiktok.com'||event.source!==activeFrame.contentWindow||!event.data||event.data['x-tiktok-player']!==true)return;
  if(event.data.type==='onPlayerError'||event.data.type==='onError')failure('Player reported an error.');
 });
})();
`;
