/*
 * X bookmarks exporter
 * 1. Open https://x.com/i/bookmarks (logged in, on a computer) and stay at the top of the page.
 * 2. Press F12 → Console (type `allow pasting` if Chrome asks), paste this whole file, press Enter.
 * 3. It scrolls through all your bookmarks and downloads bookmarks.json when it reaches the end.
 *    Use the little panel at the bottom-right to stop early or download what it has so far.
 * Nothing is sent anywhere: it only reads what x.com already shows you and saves a file.
 */
(() => {
  if (window.__xbm) { window.__xbm.panel?.remove(); window.__xbm.stop?.(); }

  const items = new Map(); // id -> bookmark
  let order = 0, running = true, idle = 0, lastSize = 0, timer;

  const unwrap = r => (r && r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r);

  function fromApi(r) {
    r = unwrap(r);
    if (!r || !r.legacy || !r.rest_id) return null;
    const L = r.legacy;
    const U = unwrap(r.core && r.core.user_results && r.core.user_results.result) || {};
    const UL = U.legacy || {};
    const note = r.note_tweet && r.note_tweet.note_tweet_results && r.note_tweet.note_tweet_results.result;
    let text = (note && note.text) || L.full_text || '';
    const urls = [].concat((note && note.entity_set && note.entity_set.urls) || [], (L.entities && L.entities.urls) || []);
    const seen = new Set();
    const links = [];
    for (const u of urls) {
      if (!u || !u.url || seen.has(u.url)) continue;
      seen.add(u.url);
      text = text.split(u.url).join(u.expanded_url || u.url);
      if (u.expanded_url) links.push(u.expanded_url);
    }
    const rawMedia = (L.extended_entities && L.extended_entities.media) || (L.entities && L.entities.media) || [];
    const media = rawMedia.map(m => {
      if (m.url) text = text.split(m.url).join('');
      const mp4 = ((m.video_info && m.video_info.variants) || [])
        .filter(v => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      return {
        type: m.type === 'photo' ? 'image' : m.type === 'animated_gif' ? 'gif' : 'video',
        url: mp4 ? mp4.url : m.media_url_https,
        thumb: m.media_url_https,
      };
    });
    const handle = (U.core && U.core.screen_name) || UL.screen_name || '';
    const name = (U.core && U.core.name) || UL.name || handle;
    const avatar = ((U.avatar && U.avatar.image_url) || UL.profile_image_url_https || '').replace('_normal.', '_bigger.');
    let quote = null;
    const qr = r.quoted_status_result && r.quoted_status_result.result;
    if (qr) {
      const q = fromApi(qr);
      if (q) quote = { id: q.id, handle: q.handle, name: q.name, text: q.text, url: q.url };
    }
    return {
      id: r.rest_id,
      url: `https://x.com/${handle || 'i'}/status/${r.rest_id}`,
      text: text.trim(),
      name, handle, avatar,
      date: L.created_at ? new Date(L.created_at).toISOString() : null,
      lang: L.lang,
      likes: L.favorite_count, retweets: L.retweet_count, replies: L.reply_count,
      quotes: L.quote_count, bookmarks: L.bookmark_count,
      views: r.views && r.views.count ? Number(r.views.count) : undefined,
      links, media, quote,
    };
  }

  function add(t) {
    if (!t || !t.id) return;
    const old = items.get(t.id);
    if (!old) { t.idx = order++; items.set(t.id, t); return; }
    if (old.src === 'dom' && t.src !== 'dom') { t.idx = old.idx; items.set(t.id, t); }
  }

  function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o.tweet_results && o.tweet_results.result) {
      const t = fromApi(o.tweet_results.result);
      if (t) { t.src = 'api'; add(t); }
    }
    for (const k in o) if (k !== 'tweet_results') walk(o[k]);
  }

  const isBookmarksApi = u => /\/graphql\/[^/]+\/Bookmark/i.test(String(u || ''));

  // Capture the data X's own page loads while scrolling.
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isBookmarksApi(url)) {
      this.addEventListener('load', () => {
        try { walk(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch (e) {}
      });
    }
    return origOpen.apply(this, arguments);
  };
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const u = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
      if (isBookmarksApi(u)) p.then(res => res.clone().json()).then(walk).catch(() => {});
    } catch (e) {}
    return p;
  };

  // Fallback: read tweets straight from the page (covers ones loaded before the script ran).
  function scrapeDom() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(a => {
      const link = [...a.querySelectorAll('a[href*="/status/"]')].find(x => x.querySelector('time'));
      if (!link) return;
      const m = link.getAttribute('href').match(/^\/([^/]+)\/status\/(\d+)/);
      if (!m || items.has(m[2])) return;
      const textEl = a.querySelector('[data-testid="tweetText"]');
      const nameEl = a.querySelector('[data-testid="User-Name"] span');
      const media = [...a.querySelectorAll('[data-testid="tweetPhoto"] img')].map(i => ({ type: 'image', url: i.src.replace(/name=\w+/, 'name=large'), thumb: i.src }));
      const vid = a.querySelector('[data-testid="videoPlayer"] video');
      if (vid) media.push({ type: 'video', url: '', thumb: vid.poster || '' });
      add({
        id: m[2], url: 'https://x.com' + link.getAttribute('href').replace(/\/(analytics|photo|video).*$/, ''),
        text: textEl ? textEl.innerText : '',
        name: nameEl ? nameEl.innerText : m[1], handle: m[1],
        avatar: (a.querySelector('[data-testid="Tweet-User-Avatar"] img') || {}).src || '',
        date: link.querySelector('time').getAttribute('datetime'),
        links: textEl ? [...textEl.querySelectorAll('a[href^="http"]')].map(x => x.href) : [],
        media, src: 'dom',
      });
    });
  }

  function download() {
    const list = [...items.values()].sort((a, b) => a.idx - b.idx).map(({ idx, src, ...rest }) => rest);
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), count: list.length, bookmarks: list }, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'bookmarks.json' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function stop() {
    running = false;
    clearInterval(timer);
    XMLHttpRequest.prototype.open = origOpen;
    window.fetch = origFetch;
  }

  // Small status panel
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#0f1419;color:#fff;font:14px system-ui,sans-serif;padding:12px 14px;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center';
  // Built with DOM calls (not innerHTML) so it also works on pages that enforce Trusted Types.
  const status = document.createElement('span');
  status.textContent = 'Starting…';
  const btn = document.createElement('button');
  btn.textContent = 'Stop & download';
  btn.style.cssText = 'background:#1d9bf0;color:#fff;border:0;border-radius:999px;padding:6px 12px;cursor:pointer;font-weight:600';
  btn.onclick = () => { stop(); download(); status.textContent = `Saved ${items.size} bookmarks`; };
  panel.append(status, btn);
  document.body.appendChild(panel);

  const IDLE_LIMIT = 25; // ~30s with no new bookmarks = reached the end
  timer = setInterval(() => {
    if (!running) return;
    scrapeDom();
    window.scrollTo(0, document.documentElement.scrollHeight);
    if (items.size === lastSize) idle++; else { idle = 0; lastSize = items.size; }
    status.textContent = `Collected ${items.size} bookmarks${idle > 5 ? ' · waiting for more…' : '…'}`;
    if (idle >= IDLE_LIMIT) {
      stop();
      download();
      status.textContent = `Done — saved ${items.size} bookmarks to bookmarks.json`;
      console.log(`[xbm] Done: ${items.size} bookmarks`);
    }
  }, 1200);

  scrapeDom();
  window.__xbm = { items, stop, download, panel };
  console.log('[xbm] Exporting bookmarks… keep this tab open and visible.');
})();
