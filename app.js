(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const els = {
    q: $('#q'), results: $('#results'), stats: $('#stats'), chips: $('#chips'), note: $('#note'),
    empty: $('#empty'), sentinel: $('#sentinel'), sort: $('#sort'), sidebar: $('#sidebar'), toast: $('#toast'),
    banner: $('#importBanner'), help: $('#help'),
  };

  const IMPORT_KEY = 'xbm-import';
  const PAGE = 30;
  const FACETS = ['cat', 'type', 'year', 'domain', 'author'];
  const FACET_NAME = { cat: 'Topic', type: 'Type', year: 'Year', domain: 'Site', author: 'From' };
  const TYPES = { image: 'Images', video: 'Videos', gif: 'GIFs', link: 'Has links', quote: 'Quote tweets', thread: 'Threads', long: 'Long posts', text: 'Text only' };
  const CORE_KEYS = ['id', 'url', 'text', 'name', 'handle', 'avatar', 'date', 'lang', 'likes', 'retweets', 'replies', 'quotes', 'bookmarks', 'views', 'links', 'media', 'quote'];
  const STOP = new Set('a an and the of to in on for is it its this that with as at by be are was were i you my me we our your'.split(' '));
  const X_HOSTS = new Set(['x.com', 'twitter.com', 't.co', 'mobile.twitter.com', 'pbs.twimg.com', 'video.twimg.com']);

  const state = {
    items: [], byId: new Map(), mini: null, source: 'published',
    filters: Object.fromEntries(FACETS.map(f => [f, new Set()])),
    facetLimit: { domain: 12, author: 15 }, facetQuery: { domain: '', author: '' },
    results: [], shown: 0, sel: -1, hl: null, pinned: null,
  };

  /* ---------- helpers ---------- */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '#';
  const fmtN = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const fmtInt = new Intl.NumberFormat('en');
  const fmtDate = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' });
  const num = v => {
    if (v == null || v === '') return undefined;
    if (typeof v === 'number') return isFinite(v) ? v : undefined;
    const m = String(v).trim().replace(/,/g, '').match(/^([\d.]+)\s*([kmb])?$/i);
    if (!m) return undefined;
    return Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1));
  };
  const host = u => { try { return new URL(u).hostname.toLowerCase().replace(/^(www\d?|m|mobile)\./, ''); } catch (e) { return ''; } };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg; els.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2200);
  }

  /* ---------- categories ---------- */
  const CATS = (window.XBM_CATEGORIES || []).map(c => {
    const parts = (c.words || []).map(w => {
      const star = w.endsWith('*');
      const base = escRe(star ? w.slice(0, -1) : w).replace(/\s+/g, '\\s+');
      return base + (star ? '[\\p{L}\\p{N}_-]*' : '');
    });
    return {
      name: c.name,
      re: parts.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${parts.join('|')})(?![\\p{L}\\p{N}_])`, 'iu') : null,
      sites: (c.sites || []).map(s => s.toLowerCase()),
      authors: new Set((c.authors || []).map(a => a.toLowerCase().replace(/^@/, ''))),
    };
  });

  /* ---------- normalization (accepts many export formats) ---------- */
  function asArray(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      for (const k of ['bookmarks', 'tweets', 'data', 'items', 'results']) if (Array.isArray(data[k])) return data[k];
    }
    return [];
  }
  const normType = t => {
    t = String(t || '').toLowerCase();
    if (t.includes('gif')) return 'gif';
    if (t.includes('video')) return 'video';
    return 'image';
  };
  function normQuote(q) {
    if (!q || typeof q !== 'object') return null;
    const text = String(q.text ?? q.full_text ?? '');
    const handle = String(q.handle ?? q.screen_name ?? q.user?.screen_name ?? '').replace(/^@/, '');
    if (!text && !handle) return null;
    return { text, handle, name: String(q.name ?? q.user?.name ?? handle), url: q.url || (handle && q.id ? `https://x.com/${handle}/status/${q.id}` : '') };
  }
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw.tweet && typeof raw.tweet === 'object' && raw.text == null && raw.full_text == null ? raw.tweet : raw;
    const user = r.user || r.author || {};
    const url0 = String(r.url || r.tweet_url || r.link || '');
    const um = url0.match(/(?:x|twitter)\.com\/([^/?#]+)\/status(?:es)?\/(\d+)/i) || [];
    const id = String(r.id ?? r.rest_id ?? r.id_str ?? r.tweet_id ?? um[2] ?? '');
    if (!/^\d+$/.test(id)) return null;
    const handle = String(r.handle ?? r.screen_name ?? r.username ?? user.screen_name ?? user.username ?? user.handle ?? um[1] ?? '').replace(/^@/, '');
    const d = new Date(r.date ?? r.created_at ?? r.createdAt ?? r.timestamp ?? NaN);
    const text = String(r.text ?? r.full_text ?? r.content ?? '');
    const media = (Array.isArray(r.media) ? r.media : []).map(m => {
      if (typeof m === 'string') return { type: /\.mp4|video/i.test(m) ? 'video' : 'image', url: m, thumb: m };
      const type = normType(m.type);
      const url = m.url || m.original || m.media_url_https || m.src || '';
      return { type, url, thumb: m.thumb || m.thumbnail || m.preview || m.poster || m.media_url_https || (type === 'image' ? url : '') };
    }).filter(m => m.url || m.thumb);
    const rawLinks = r.links || r.urls || r.expanded_urls || r.entities?.urls || [];
    const links = [...new Set((Array.isArray(rawLinks) ? rawLinks : [])
      .map(l => typeof l === 'string' ? l : (l?.expanded_url || l?.expanded || l?.url || ''))
      .concat(text.match(/https?:\/\/[^\s<>"]+/g) || [])
      .map(l => l.replace(/[.,;:!?)'"”’\]]+$/, ''))
      .filter(l => /^https?:\/\//i.test(l)))];
    return {
      id, handle, text,
      url: /^https?:\/\//.test(url0) ? url0 : `https://x.com/${handle || 'i'}/status/${id}`,
      name: String(r.name ?? user.name ?? handle),
      avatar: String(r.avatar ?? r.profile_image_url_https ?? r.profile_image_url ?? user.profile_image_url_https ?? user.profile_image_url ?? user.avatar ?? ''),
      date: isNaN(d) ? null : d.toISOString(),
      lang: r.lang || undefined,
      likes: num(r.likes ?? r.favorite_count ?? r.like_count),
      retweets: num(r.retweets ?? r.retweet_count),
      replies: num(r.replies ?? r.reply_count),
      quotes: num(r.quotes ?? r.quote_count),
      bookmarks: num(r.bookmarks ?? r.bookmark_count),
      views: num(r.views ?? r.views_count ?? r.view_count),
      links, media,
      quote: normQuote(r.quote ?? r.quoted ?? r.quoted_tweet ?? r.quoted_status),
    };
  }

  function enrich(core, idx) {
    const it = Object.assign({}, core);
    it.idx = idx;
    it.time = it.date ? Date.parse(it.date) : NaN;
    it.year = isNaN(it.time) ? '' : String(new Date(it.time).getFullYear());
    it.domains = [...new Set(it.links.map(host).filter(h => h && !X_HOSTS.has(h)))];
    it.hashtags = [...new Set((it.text.match(/(?<![\p{L}\p{N}_])#[\p{L}\p{N}_]+/gu) || []).map(h => h.toLowerCase()))];
    const types = new Set(it.media.map(m => m.type));
    if (it.domains.length) types.add('link');
    if (it.quote) types.add('quote');
    if (/🧵|\bthread\b|^\s*1\s*[/.)]|\(1\/\d+\)|\b1\/\d{1,2}\b/im.test(it.text)) types.add('thread');
    if (it.text.length > 280) types.add('long');
    if (!it.media.length && !it.domains.length && !it.quote) types.add('text');
    it.types = [...types];
    const catText = [it.text, it.quote?.text || '', it.links.join(' ')].join('\n');
    const handle = it.handle.toLowerCase();
    it.cats = CATS.filter(c => (c.re && c.re.test(catText)) || c.authors.has(handle) || it.domains.some(d => c.sites.some(s => d === s || d.endsWith('.' + s)))).map(c => c.name);
    return it;
  }

  // Bookmarks whose text says nothing (e.g. a bare design shot) inherit their author's usual topic:
  // the most common topic among that author's other bookmarks, if it covers at least half of them.
  function finishCats(items) {
    const byAuthor = new Map();
    for (const it of items) {
      if (!it.cats.length) continue;
      const h = it.handle.toLowerCase();
      const a = byAuthor.get(h) || { n: 0, c: new Map() };
      a.n++;
      for (const c of it.cats) a.c.set(c, (a.c.get(c) || 0) + 1);
      byAuthor.set(h, a);
    }
    for (const it of items) {
      if (!it.cats.length) {
        const a = byAuthor.get(it.handle.toLowerCase());
        const top = a && [...a.c].sort((x, y) => y[1] - x[1])[0];
        it.cats = top && top[1] * 2 >= a.n ? [top[0]] : ['Other'];
      }
      it.hay = [it.text, it.name, '@' + it.handle, it.quote?.text, it.quote?.handle, it.links.join(' '), it.cats.join(' ')].join('\n').toLowerCase();
    }
  }

  /* ---------- index ---------- */
  function processTerm(t) {
    const s = t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    return s && !STOP.has(s) ? s : null;
  }
  function setData(rawList, source) {
    const seen = new Set();
    const cores = [];
    for (const raw of rawList) {
      const c = normalize(raw);
      if (c && !seen.has(c.id)) { seen.add(c.id); cores.push(c); }
    }
    state.items = cores.map(enrich);
    finishCats(state.items);
    state.byId = new Map(state.items.map(it => [it.id, it]));
    state.source = source;
    state.mini = null;
    if (window.MiniSearch) {
      state.mini = new MiniSearch({
        fields: ['text', 'author', 'quote', 'links', 'tags'],
        processTerm,
        searchOptions: {
          boost: { author: 2.5, text: 1.6, tags: 1.4, links: 1.2, quote: 1 },
          prefix: t => t.length >= 3,
          fuzzy: t => (t.length >= 4 ? 0.2 : false),
          maxFuzzy: 3,
        },
      });
      state.mini.addAll(state.items.map(it => ({
        id: it.id,
        text: it.text,
        author: `${it.name} ${it.handle}`,
        quote: it.quote ? `${it.quote.text} ${it.quote.name} ${it.quote.handle}` : '',
        links: it.links.join(' ') + ' ' + it.domains.join(' '),
        tags: it.hashtags.join(' ') + ' ' + it.cats.join(' '),
      })));
    }
    els.banner.hidden = source !== 'import';
  }

  /* ---------- query parsing ---------- */
  const HAS = { media: 'media', image: 'image', images: 'image', photo: 'image', photos: 'image', pic: 'image', pics: 'image', video: 'video', videos: 'video', gif: 'gif', gifs: 'gif', link: 'link', links: 'link', url: 'link', urls: 'link', quote: 'quote', quotes: 'quote', thread: 'thread', threads: 'thread', long: 'long', text: 'text' };
  const OPS = { from: 'from', by: 'from', author: 'from', has: 'has', is: 'has', type: 'has', cat: 'cat', topic: 'cat', in: 'cat', site: 'site', domain: 'site', url: 'site', after: 'after', since: 'after', before: 'before', until: 'before', year: 'year', likes: 'likes', min_likes: 'likes', min_faves: 'likes', faves: 'likes', lang: 'lang' };
  function parseDate(s, end) {
    const m = String(s).match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
    if (!m) { const t = Date.parse(s); return isNaN(t) ? null : t; }
    const y = +m[1], mo = m[2] ? +m[2] - 1 : 0, d = m[3] ? +m[3] : 1;
    if (!end) return Date.UTC(y, mo, d);
    return m[3] ? Date.UTC(y, mo, d + 1) : m[2] ? Date.UTC(y, mo + 1, 1) : Date.UTC(y + 1, 0, 1);
  }
  function parseQuery(q) {
    const p = { words: [], phrases: [], not: [], from: [], has: [], cat: [], site: [], year: [], lang: [], after: null, before: null, likes: 0, or: false };
    const re = /(-)?(?:([a-z_]+):)?(?:"([^"]*)"?|(\S+))/gi;
    let m;
    while ((m = re.exec(q))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const neg = !!m[1], key = (m[2] || '').toLowerCase(), isPhrase = m[3] != null;
      const val = (isPhrase ? m[3] : m[4] || '').trim();
      const op = OPS[key];
      if (key && !op) { // not an operator (e.g. a URL) — treat as text
        const raw = (key + ':' + val).toLowerCase();
        (neg ? p.not : p.phrases).push(raw);
        continue;
      }
      if (!val) continue;
      const v = val.toLowerCase();
      if (op) {
        if (op === 'after') p.after = parseDate(v, false);
        else if (op === 'before') p.before = parseDate(v, false);
        else if (op === 'likes') p.likes = num(v) || 0;
        else if (op === 'has') p.has.push(HAS[v] || v);
        else p[op].push(v);
        continue;
      }
      if (!isPhrase && v === 'or' && !neg) { p.or = true; continue; }
      if (!isPhrase && /^@\w+$/.test(v) && !neg) { p.from.push(v.slice(1)); continue; }
      if (neg) { p.not.push(v); continue; }
      if (isPhrase) { if (v.includes(' ')) p.phrases.push(v); else p.words.push(v); continue; }
      p.words.push(v);
    }
    p.words = p.words.filter(w => !STOP.has(w));
    return p;
  }

  /* ---------- search ---------- */
  function search() {
    const t0 = performance.now();
    const q = els.q.value.trim();
    const p = parseQuery(q);
    const freeText = p.words.join(' ');
    let scored; // Map id -> score
    let terms = [...p.words, ...p.phrases];
    let note = '';

    if (state.pinned && state.byId.has(state.pinned)) {
      scored = new Map([[state.pinned, 1]]);
    } else if (p.words.length) {
      scored = new Map();
      if (state.mini) {
        let res = state.mini.search(freeText, { combineWith: p.or ? 'OR' : 'AND' });
        if (!res.length && p.words.length > 1 && !p.or) {
          res = state.mini.search(freeText, { combineWith: 'OR' });
          if (res.length) note = 'No bookmark has all of those words — showing ones that match some of them.';
        }
        res.forEach((r, i) => {
          scored.set(r.id, r.score);
          if (i < 300) terms.push(...r.terms);
        });
      }
      // Substring safety net: catches things the tokenizer splits oddly (URLs, code, handles, Hindi…)
      const words = p.words.filter(w => !STOP.has(w));
      if (words.length) {
        for (const it of state.items) {
          if (scored.has(it.id)) continue;
          if (p.or ? words.some(w => it.hay.includes(w)) : words.every(w => it.hay.includes(w))) scored.set(it.id, 0.001);
        }
      }
    } else {
      scored = new Map(state.items.map(it => [it.id, 0]));
    }

    const notRes = p.not.map(w => new RegExp(`(?<![\\p{L}\\p{N}])${escRe(w)}`, 'iu'));
    const pass = it => {
      if (p.phrases.length && !p.phrases.every(ph => it.hay.includes(ph))) return false;
      if (notRes.some(r => r.test(it.hay))) return false;
      if (p.from.length && !p.from.some(f => it.handle.toLowerCase().includes(f) || it.name.toLowerCase().includes(f))) return false;
      if (p.has.length && !p.has.every(h => h === 'media' ? it.media.length > 0 : it.types.includes(h))) return false;
      if (p.cat.length && !p.cat.every(c => it.cats.some(x => x.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(c.replace(/[^a-z0-9]+/g, ''))))) return false;
      if (p.site.length && !p.site.every(s => it.domains.some(d => d.includes(s)) || it.links.some(l => l.toLowerCase().includes(s)))) return false;
      if (p.year.length && !p.year.includes(it.year)) return false;
      if (p.lang.length && !p.lang.includes(String(it.lang || '').toLowerCase())) return false;
      if (p.after != null && !(it.time >= p.after)) return false;
      if (p.before != null && !(it.time < p.before)) return false;
      if (p.likes && !((it.likes || 0) >= p.likes)) return false;
      return true;
    };

    // Facets: an item counts toward facet F when it passes every *other* facet group.
    const counts = Object.fromEntries(FACETS.map(f => [f, new Map()]));
    const active = FACETS.filter(f => state.filters[f].size);
    const facetVals = (it, f) => f === 'cat' ? it.cats : f === 'type' ? it.types : f === 'year' ? (it.year ? [it.year] : []) : f === 'domain' ? it.domains : [it.handle.toLowerCase()];
    const results = [];
    for (const id of scored.keys()) {
      const it = state.byId.get(id);
      if (!it || !pass(it)) continue;
      let failed = null, fails = 0;
      for (const f of active) {
        if (!facetVals(it, f).some(v => state.filters[f].has(v))) { failed = f; if (++fails > 1) break; }
      }
      if (fails > 1) continue;
      for (const f of FACETS) {
        if (fails === 1 && f !== failed) continue;
        const c = counts[f];
        for (const v of facetVals(it, f)) c.set(v, (c.get(v) || 0) + 1);
      }
      if (!fails) results.push(it);
    }

    const sort = els.sort.value;
    const byScore = (a, b) => (scored.get(b.id) - scored.get(a.id)) || (a.idx - b.idx);
    const cmp = {
      auto: p.words.length ? byScore : (a, b) => a.idx - b.idx,
      saved: (a, b) => a.idx - b.idx,
      'saved-old': (a, b) => b.idx - a.idx,
      new: (a, b) => (b.time || 0) - (a.time || 0),
      old: (a, b) => (a.time || Infinity) - (b.time || Infinity),
      likes: (a, b) => (b.likes || 0) - (a.likes || 0),
      views: (a, b) => (b.views || 0) - (a.views || 0),
    }[sort] || byScore;
    results.sort(cmp);

    state.results = results;
    state.counts = counts;
    state.sel = -1;
    state.hl = buildHl(terms);
    state.ms = performance.now() - t0;
    state.note = note;
    state.query = p;
  }

  function buildHl(terms) {
    const ts = [...new Set(terms.map(t => String(t).toLowerCase()).filter(t => t.length >= 2 && !STOP.has(t)))].sort((a, b) => b.length - a.length);
    return ts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${ts.map(escRe).join('|')})`, 'giu') : null;
  }
  function hl(s) {
    s = String(s ?? '');
    if (!state.hl) return esc(s);
    let out = '', last = 0;
    s.replace(state.hl, (m, g, off) => { out += esc(s.slice(last, off)) + '<mark>' + esc(m) + '</mark>'; last = off + m.length; return m; });
    return out + esc(s.slice(last));
  }

  /* ---------- rendering ---------- */
  const ICON = {
    reply: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4V5zm2 2v8.8L8.3 14H18V7H6z"/></svg>',
    rt: '<svg viewBox="0 0 24 24"><path d="M7 4l4 4H8v8h5l2 2H6V8H3l4-4zm10 16l-4-4h3V8h-5L9 6h9v10h3l-4 4z"/></svg>',
    like: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2.1 0 3.6 1.2 4.4 2.5.8-1.3 2.3-2.5 4.4-2.5C19 5 21 8.6 19.6 11.8 17.5 16.4 12 21 12 21z"/></svg>',
    views: '<svg viewBox="0 0 24 24"><path d="M4 20V10h3v10H4zm6.5 0V4h3v16h-3zM17 20v-7h3v7h-3z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><path d="M8 3h11v13h-2V5H8V3zM5 7h10v14H5V7zm2 2v10h6V9H7z"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3zM5 5h6v2H7v10h10v-4h2v6H5V5z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  };

  function richText(text) {
    const re = /(https?:\/\/[^\s<>"]+)|((?<![\w@])@\w{1,15})|((?<![\p{L}\p{N}_&])#[\p{L}\p{N}_]+)/gu;
    let out = '', last = 0, m;
    while ((m = re.exec(text))) {
      out += hl(text.slice(last, m.index));
      let tok = m[0], trail = '';
      if (m[1]) { const t = tok.match(/[.,;:!?)'"”’\]]+$/); if (t) { trail = t[0]; tok = tok.slice(0, -trail.length); } }
      if (m[1]) {
        const shown = tok.replace(/^https?:\/\/(www\.)?/, '');
        out += `<a href="${esc(safeUrl(tok))}" target="_blank" rel="noopener noreferrer">${hl(shown.length > 48 ? shown.slice(0, 46) + '…' : shown)}</a>`;
      } else if (m[2]) {
        out += `<a href="https://x.com/${esc(tok.slice(1))}" target="_blank" rel="noopener noreferrer">${hl(tok)}</a>`;
      } else {
        out += `<a href="#" data-q="${esc(tok)}">${hl(tok)}</a>`;
      }
      out += hl(trail);
      last = m.index + m[0].length;
    }
    return out + hl(text.slice(last));
  }

  function card(it, i) {
    const date = it.time ? `<a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" title="${esc(new Date(it.time).toLocaleString())}">${fmtDate.format(it.time)}</a>` : '';
    const long = it.text.length > 600 || it.text.split('\n').length > 10;
    const media = it.media.slice(0, 4);
    const mediaHtml = media.length ? `<div class="media n${media.length}">${media.map(m => {
      const isVid = m.type !== 'image';
      const href = isVid ? it.url : (m.url || m.thumb);
      const src = m.thumb || m.url;
      return `<a href="${esc(safeUrl(href))}" target="_blank" rel="noopener noreferrer"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(safeUrl(src))}" alt="">${isVid ? `<span class="play">${ICON.play}</span>` : ''}</a>`;
    }).join('')}</div>` : '';
    const ext = it.links.filter(l => { const h = host(l); return h && !X_HOSTS.has(h); });
    const linksHtml = ext.length ? `<div class="links">${ext.slice(0, 6).map(l => {
      const h = host(l);
      return `<a href="${esc(safeUrl(l))}" target="_blank" rel="noopener noreferrer" title="${esc(l)}"><img loading="lazy" src="https://icons.duckduckgo.com/ip3/${esc(h)}.ico" alt="" onerror="this.remove()">${hl(h)}</a>`;
    }).join('')}</div>` : '';
    const q = it.quote;
    const quoteHtml = q ? `<div class="quote"><div class="qwho"><b>${hl(q.name)}</b> ${q.handle ? '@' + hl(q.handle) : ''} ${q.url ? `· <a href="${esc(safeUrl(q.url))}" target="_blank" rel="noopener noreferrer">open</a>` : ''}</div><div class="text">${richText(q.text)}</div></div>` : '';
    const metric = (icon, v, title) => v != null ? `<span class="m" title="${title}">${icon}${fmtN.format(v)}</span>` : '';
    return `<article class="card" data-i="${i}" data-id="${esc(it.id)}">
      <div class="card-head">
        ${it.avatar ? `<img class="avatar" loading="lazy" referrerpolicy="no-referrer" src="${esc(safeUrl(it.avatar))}" alt="" onerror="this.style.visibility='hidden'">` : '<div class="avatar"></div>'}
        <div class="who">
          <a class="name" href="#" data-author="${esc(it.handle.toLowerCase())}" title="Show only bookmarks from ${esc(it.name)}">${hl(it.name)}</a>
          <div class="meta"><a href="https://x.com/${esc(it.handle)}" target="_blank" rel="noopener noreferrer">@${hl(it.handle)}</a>${date ? ' · ' + date : ''}</div>
        </div>
        <div class="card-actions">
          <button class="icon-btn" data-copy title="Copy link (c)" aria-label="Copy link">${ICON.copy}</button>
          <a class="icon-btn" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" title="Open on X (Enter)" aria-label="Open on X">${ICON.open}</a>
        </div>
      </div>
      ${it.text ? `<div class="text${long ? ' clamp' : ''}">${richText(it.text)}</div>${long ? '<button class="expand">Show more</button>' : ''}` : ''}
      ${quoteHtml}${mediaHtml}${linksHtml}
      <div class="card-foot">
        ${metric(ICON.reply, it.replies, 'Replies')}${metric(ICON.rt, it.retweets, 'Reposts')}${metric(ICON.like, it.likes, 'Likes')}${metric(ICON.views, it.views, 'Views')}
        <div class="tags">${it.cats.map(c => `<button class="tag" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      </div>
    </article>`;
  }

  function renderMore() {
    if (state.shown >= state.results.length) return;
    const next = state.results.slice(state.shown, state.shown + PAGE);
    els.results.insertAdjacentHTML('beforeend', next.map((it, k) => card(it, state.shown + k)).join(''));
    state.shown += next.length;
  }

  function renderStats() {
    const total = state.items.length;
    if (!total) { els.stats.innerHTML = ''; return; }
    const filtered = els.q.value.trim() || FACETS.some(f => state.filters[f].size) || state.pinned;
    if (filtered) {
      els.stats.innerHTML = `<span><b>${fmtInt.format(state.results.length)}</b> of ${fmtInt.format(total)} bookmarks</span><span>${state.ms < 1 ? '<1' : Math.round(state.ms)} ms</span>`;
    } else {
      const people = new Set(state.items.map(it => it.handle.toLowerCase())).size;
      const years = state.items.map(it => it.year).filter(Boolean).sort();
      els.stats.innerHTML = `<span><b>${fmtInt.format(total)}</b> bookmarks</span><span><b>${fmtInt.format(people)}</b> people</span>${years.length ? `<span>${years[0]} – ${years[years.length - 1]}</span>` : ''}<span class="muted">Press <kbd>/</kbd> to search, <kbd>?</kbd> for tricks</span>`;
    }
  }

  function renderChips() {
    const chips = [];
    if (state.pinned) chips.push(`<button class="chip" data-unpin>🎲 Random pick <i>✕</i></button><button class="chip clear" data-random>Another one</button>`);
    for (const f of FACETS) for (const v of state.filters[f]) {
      const label = f === 'type' ? TYPES[v] || v : f === 'author' ? '@' + v : v;
      chips.push(`<button class="chip" data-unfacet="${f}" data-v="${esc(v)}"><span>${FACET_NAME[f]}:</span>${esc(label)}<i>✕</i></button>`);
    }
    if (chips.length > 1 || (chips.length && els.q.value.trim())) chips.push('<button class="chip clear" data-clearall>Clear all</button>');
    els.chips.innerHTML = chips.join('');
  }

  function renderFacets() {
    for (const f of FACETS) {
      const box = $(`.facet[data-facet="${f}"]`);
      const ul = $('ul', box);
      const counts = state.counts[f];
      const sel = state.filters[f];
      let keys = [...new Set([...counts.keys(), ...sel])];
      if (f === 'year') keys.sort((a, b) => b.localeCompare(a));
      else if (f === 'type') keys = Object.keys(TYPES).filter(k => counts.has(k) || sel.has(k));
      else keys.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b));
      if (f === 'cat') keys = keys.filter(k => k !== 'Other').concat(keys.includes('Other') ? ['Other'] : []);
      let authorInfo;
      if (f === 'author') {
        authorInfo = new Map();
        for (const it of state.items) { const h = it.handle.toLowerCase(); if (!authorInfo.has(h)) authorInfo.set(h, it); }
      }
      const fq = (state.facetQuery[f] || '').toLowerCase();
      if (fq) keys = keys.filter(k => k.includes(fq) || (authorInfo && (authorInfo.get(k)?.name || '').toLowerCase().includes(fq)));
      const limit = state.facetLimit[f];
      const total = keys.length;
      if (limit) keys = [...keys.filter(k => sel.has(k)), ...keys.filter(k => !sel.has(k)).slice(0, limit)];
      ul.innerHTML = keys.map(k => {
        const n = counts.get(k) || 0;
        let label = esc(k), pre = '';
        if (f === 'type') label = esc(TYPES[k] || k);
        if (f === 'author') {
          const a = authorInfo.get(k);
          label = `${esc(a?.name || k)} <span class="muted">@${esc(a?.handle || k)}</span>`;
          pre = a?.avatar ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(safeUrl(a.avatar))}" alt="" onerror="this.style.visibility='hidden'">` : '';
        }
        if (f === 'domain') pre = `<img loading="lazy" src="https://icons.duckduckgo.com/ip3/${esc(k)}.ico" alt="" onerror="this.style.visibility='hidden'">`;
        return `<li class="${sel.has(k) ? 'on' : ''}${n ? '' : ' zero'}" data-facet="${f}" data-v="${esc(k)}">${pre}<span class="lbl">${label}</span><span class="n">${fmtInt.format(n)}</span></li>`;
      }).join('') + (limit && total > keys.length ? `<li class="more-row"><button class="more" data-more="${f}">Show more (${fmtInt.format(total - keys.length)})</button></li>` : '');
      box.hidden = f !== 'cat' && f !== 'type' && !keys.length && !fq;
    }
  }

  function renderEmpty() {
    if (!state.items.length) {
      els.empty.className = 'empty onboard';
      els.empty.innerHTML = `<h2>No bookmarks loaded yet</h2>
        <p>Get all your X bookmarks into this page in about a minute:</p>
        <ol>
          <li>Open <a href="https://x.com/i/bookmarks" target="_blank" rel="noopener">x.com/i/bookmarks</a> on a computer (logged in).</li>
          <li>Press <kbd>F12</kbd> → <b>Console</b>. Chrome may ask you to type <code>allow pasting</code> first.</li>
          <li>Paste the contents of <a href="export-bookmarks.js" target="_blank">export-bookmarks.js</a> and press <kbd>Enter</kbd>. It scrolls through everything and downloads <code>bookmarks.json</code>.</li>
          <li>Import that file below to preview it, or upload it to the repo root to publish it here.</li>
        </ol>
        <p><label class="btn" style="display:inline-block">Import bookmarks.json<input type="file" accept=".json,application/json" hidden data-import></label></p>`;
      els.empty.hidden = false;
      return;
    }
    if (!state.results.length) {
      els.empty.className = 'empty';
      els.empty.innerHTML = `<h2>Nothing found</h2><p>Try fewer words, remove a filter, or check the <a href="#" data-help>search tricks</a>.</p>`;
      els.empty.hidden = false;
      return;
    }
    els.empty.hidden = true;
  }

  function run({ keepScroll = false } = {}) {
    search();
    els.results.innerHTML = '';
    state.shown = 0;
    renderMore();
    renderStats(); renderChips(); renderFacets(); renderEmpty();
    els.note.hidden = !state.note; els.note.textContent = state.note || '';
    if (!keepScroll) window.scrollTo({ top: 0 });
    writeUrl();
    kick();
  }

  /* ---------- URL state ---------- */
  function writeUrl() {
    const sp = new URLSearchParams();
    const q = els.q.value.trim();
    if (q) sp.set('q', q);
    if (els.sort.value !== 'auto') sp.set('sort', els.sort.value);
    for (const f of FACETS) for (const v of state.filters[f]) sp.append(f, v);
    const s = sp.toString();
    history.replaceState(null, '', s ? '?' + s : location.pathname);
  }
  function readUrl() {
    const sp = new URLSearchParams(location.search);
    els.q.value = sp.get('q') || '';
    const sort = sp.get('sort');
    if (sort && $(`option[value="${CSS.escape(sort)}"]`, els.sort)) els.sort.value = sort;
    for (const f of FACETS) state.filters[f] = new Set(sp.getAll(f));
  }

  /* ---------- interactions ---------- */
  function toggleFacet(f, v) {
    const s = state.filters[f];
    s.has(v) ? s.delete(v) : s.add(v);
    state.pinned = null;
    run();
  }
  function select(i) {
    const cards = $$('.card', els.results);
    if (!cards.length) return;
    while (i >= state.shown && state.shown < state.results.length) renderMore();
    i = Math.max(0, Math.min(i, state.results.length - 1));
    $$('.card.sel', els.results).forEach(c => c.classList.remove('sel'));
    const c = $(`.card[data-i="${i}"]`, els.results);
    if (!c) return;
    c.classList.add('sel');
    c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    state.sel = i;
  }
  async function copyLink(it) {
    try { await navigator.clipboard.writeText(it.url); toast('Link copied'); } catch (e) { prompt('Copy link:', it.url); }
  }
  function randomPick() {
    const pool = state.pinned ? state.items : (state.results.length ? state.results : state.items);
    if (!pool.length) return;
    let it = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && it.id === state.pinned) it = pool[(pool.indexOf(it) + 1) % pool.length];
    state.pinned = it.id;
    run();
  }

  let debounce;
  els.q.addEventListener('input', () => {
    clearTimeout(debounce);
    state.pinned = null;
    debounce = setTimeout(() => run(), 70);
  });
  els.q.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (els.q.value) { els.q.value = ''; run(); } else els.q.blur(); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'Enter') { if (state.results.length) { e.preventDefault(); els.q.blur(); select(0); } }
  });
  els.sort.addEventListener('change', () => run());

  document.addEventListener('click', e => {
    const t = e.target.closest('li[data-facet],[data-unfacet],[data-cat],[data-author],[data-q],[data-more],[data-copy],[data-clearall],[data-unpin],[data-random],[data-help],.expand');
    if (!t) return;
    if (t.matches('li[data-facet]')) { toggleFacet(t.dataset.facet, t.dataset.v); return; }
    e.preventDefault();
    if (t.dataset.unfacet) toggleFacet(t.dataset.unfacet, t.dataset.v);
    else if (t.dataset.cat) { if (!state.filters.cat.has(t.dataset.cat)) toggleFacet('cat', t.dataset.cat); }
    else if (t.dataset.author) { if (!state.filters.author.has(t.dataset.author)) toggleFacet('author', t.dataset.author); }
    else if (t.dataset.q) { els.q.value = t.dataset.q; state.pinned = null; run(); }
    else if (t.dataset.more) { state.facetLimit[t.dataset.more] += 40; renderFacets(); }
    else if (t.hasAttribute('data-copy')) { const it = state.byId.get(t.closest('.card').dataset.id); if (it) copyLink(it); }
    else if (t.hasAttribute('data-clearall')) { els.q.value = ''; FACETS.forEach(f => state.filters[f].clear()); state.pinned = null; run(); }
    else if (t.hasAttribute('data-unpin')) { state.pinned = null; run(); }
    else if (t.hasAttribute('data-random')) randomPick();
    else if (t.hasAttribute('data-help')) els.help.showModal();
    else if (t.classList.contains('expand')) {
      const txt = t.previousElementSibling;
      const open = txt.classList.toggle('clamp');
      t.textContent = open ? 'Show more' : 'Show less';
    }
  });

  $$('.facet-search').forEach(inp => inp.addEventListener('input', () => {
    const f = inp.closest('.facet').dataset.facet;
    state.facetQuery[f] = inp.value.trim();
    renderFacets();
  }));

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || els.help.open;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const it = state.results[state.sel];
    switch (e.key) {
      case '/': e.preventDefault(); els.q.focus(); els.q.select(); break;
      case 'j': select(state.sel + 1); break;
      case 'k': if (state.sel <= 0) { els.q.focus(); $$('.card.sel').forEach(c => c.classList.remove('sel')); state.sel = -1; } else select(state.sel - 1); break;
      case 'Enter': case 'o': if (it) window.open(it.url, '_blank', 'noopener'); break;
      case 'c': if (it) copyLink(it); break;
      case 'r': randomPick(); break;
      case '?': els.help.showModal(); break;
      case 'Escape': if (state.pinned) { state.pinned = null; run(); } break;
    }
  });

  $('#helpBtn').addEventListener('click', () => els.help.showModal());
  $('#randomBtn').addEventListener('click', randomPick);
  $('#themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('xbm-theme', root.dataset.theme);
  });
  $('#filtersBtn').addEventListener('click', () => els.sidebar.classList.add('open'));
  $('#closeFilters').addEventListener('click', () => els.sidebar.classList.remove('open'));

  // Re-observing after each batch makes the observer re-check, so short pages keep filling.
  const io = new IntersectionObserver(entries => { if (entries[0].isIntersecting && state.shown < state.results.length) { renderMore(); kick(); } }, { rootMargin: '1200px' });
  const kick = () => { io.unobserve(els.sentinel); io.observe(els.sentinel); };
  kick();
  // Fallback for browsers/webviews where the observer is throttled.
  let scrollTimer = 0;
  addEventListener('scroll', () => {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = 0;
      while (state.shown < state.results.length && els.sentinel.getBoundingClientRect().top < innerHeight + 1200) renderMore();
    }, 60);
  }, { passive: true });

  /* ---------- import / export ---------- */
  async function importFile(file) {
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { toast('That file is not valid JSON'); return; }
    const list = asArray(data);
    const cores = list.map(normalize).filter(Boolean);
    if (!cores.length) { toast('No bookmarks found in that file'); return; }
    const saved = store.set(IMPORT_KEY, JSON.stringify(cores));
    setData(cores, 'import');
    FACETS.forEach(f => state.filters[f].clear());
    els.q.value = ''; state.pinned = null;
    run();
    toast(`Loaded ${fmtInt.format(state.items.length)} bookmarks${saved ? '' : ' (too big to remember after reload)'}`);
  }
  document.addEventListener('change', e => {
    if (e.target.matches('#fileInput, [data-import]')) { importFile(e.target.files[0]); e.target.value = ''; }
  });
  $('#clearImport').addEventListener('click', async () => { store.del(IMPORT_KEY); await loadPublished(); run(); });
  $('#downloadNorm').addEventListener('click', () => {
    const out = state.items.map(it => Object.fromEntries(CORE_KEYS.filter(k => it[k] != null).map(k => [k, it[k]])));
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), count: out.length, bookmarks: out }, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'bookmarks.json' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  /* ---------- boot ---------- */
  async function loadPublished() {
    try {
      const res = await fetch('bookmarks.json', { cache: 'no-cache' });
      setData(res.ok ? asArray(await res.json()) : [], 'published');
    } catch (e) {
      setData([], 'published');
    }
  }
  (async () => {
    let imported = null;
    try { imported = JSON.parse(store.get(IMPORT_KEY) || 'null'); } catch (e) {}
    if (Array.isArray(imported) && imported.length) setData(imported, 'import');
    else await loadPublished();
    readUrl();
    run({ keepScroll: true });
    if (!window.MiniSearch && state.items.length) toast('Search library failed to load — using basic search');
  })();
})();
