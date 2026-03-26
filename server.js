const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT    = process.env.PORT || 3000;
const API_KEY = 'AIzaSyARkQ9E3BDpoaAJG_0AFtmn_Z51E61GZC0';

// ─── HTTPS GET → JSON ────────────────────────────────────────────────────────
function getJSON(targetUrl) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, { headers: { 'Accept': 'application/json' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('JSON parse error: ' + body.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Places API (New) — GET with field mask ──────────────────────────────────
// Returns socialMediaLinks which contains Instagram from Google My Business "Perfis"
function placesNewGet(placeId, fieldMask) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'places.googleapis.com',
      path:     '/v1/places/' + placeId,
      method:   'GET',
      headers: {
        'X-Goog-Api-Key':   API_KEY,
        'X-Goog-FieldMask': fieldMask,
        'Accept':           'application/json',
      }
    };
    let body = '';
    const req = https.request(opts, res => {
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ─── Fetch website HTML ───────────────────────────────────────────────────────
function fetchSite(siteUrl, ms = 7000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(siteUrl); } catch { reject(new Error('invalid url')); return; }
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      timeout:  ms,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection':      'close',
      }
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, res => {
      // Follow redirects (max 3)
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : u.protocol + '//' + u.hostname + res.headers.location;
        fetchSite(loc, ms).then(resolve).catch(reject);
        return;
      }
      let body = '';
      res.on('data', c => { if (body.length < 500000) body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Extract Instagram handle from socialMediaLinks ──────────────────────────
function igFromLinks(links) {
  if (!Array.isArray(links)) return null;
  const SKIP = new Set(['p','reel','reels','explore','stories','accounts','share','sharer','tv']);
  for (const item of links) {
    const raw = typeof item === 'string' ? item : (item.uri || item.url || '');
    if (!raw.toLowerCase().includes('instagram.com/')) continue;
    const m = raw.match(/instagram\.com\/([a-zA-Z0-9._]{2,30})/i);
    if (m && m[1] && !SKIP.has(m[1].toLowerCase())) return m[1].toLowerCase();
  }
  return null;
}

// ─── Extract Instagram handle from HTML ──────────────────────────────────────
function igFromHTML(html) {
  const SKIP = new Set(['p','reel','reels','stories','explore','accounts','_i','sharer',
    'share','direct','tv','ar','about','legal','help','blog','press','api','oauth',
    'challenge','login','signup','instagram','privacy','safety','support']);
  const rx = /instagram\.com\/([a-zA-Z0-9._]{2,30})(?:["'\/?<\s]|$)/g;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const h = m[1].replace(/\/$/, '').toLowerCase();
    if (!SKIP.has(h) && !h.startsWith('_') && h.length >= 3) return h;
  }
  return null;
}

// ─── Extract Brazilian phone from HTML ───────────────────────────────────────
function phoneFromHTML(html) {
  const rx = /(?:\+55[\s-]?)?(?:\(?0?[1-9]{2}\)?[\s-]?)?(?:9[\s-]?\d{4}|[2-9]\d{3})[\s-]?\d{4}/g;
  const m = html.match(rx);
  if (!m) return null;
  const cleaned = m[0].replace(/[^\d+]/g, '');
  return cleaned.length >= 10 ? m[0].trim() : null;
}

// ─── MIME ─────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS — allow all origins so iframe on WordPress works
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const sendJSON = (data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // ── /api/geocode ─────────────────────────────────────────────────────────
  if (pathname === '/api/geocode') {
    const address = parsed.query.address || '';
    console.log('[geocode]', address);
    try {
      const data = await getJSON(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=BR&language=pt-BR&key=${API_KEY}`
      );
      console.log('[geocode] status:', data.status);
      sendJSON(data);
    } catch(e) {
      console.error('[geocode] error:', e.message);
      sendJSON({ status: 'ERROR', error_message: e.message }, 500);
    }
    return;
  }

  // ── /api/places ──────────────────────────────────────────────────────────
  if (pathname === '/api/places') {
    const q = parsed.query;
    let apiUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q.query||'')}&location=${q.lat},${q.lng}&radius=${q.radius||10000}&region=BR&language=pt-BR&key=${API_KEY}`;
    if (q.pagetoken) apiUrl += `&pagetoken=${encodeURIComponent(q.pagetoken)}`;
    console.log('[places] query:', q.query, '| lat:', q.lat, '| pagetoken:', !!q.pagetoken);
    try {
      const data = await getJSON(apiUrl);
      console.log('[places] status:', data.status, '| results:', data.results?.length || 0);
      sendJSON(data);
    } catch(e) {
      console.error('[places] error:', e.message);
      sendJSON({ status: 'ERROR', error_message: e.message }, 500);
    }
    return;
  }

  // ── /api/details ─────────────────────────────────────────────────────────
  if (pathname === '/api/details') {
    const placeId = parsed.query.place_id || '';
    if (!placeId) { sendJSON({ status: 'ERROR', error_message: 'missing place_id' }, 400); return; }
    console.log('[details] placeId:', placeId.slice(0, 25));

    let phone = null, website = null, instagram = null, igSource = null;

    // Parallel: Legacy API (phone+website) + New API (socialMediaLinks)
    const [legacyData, newApiData] = await Promise.allSettled([
      getJSON(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=formatted_phone_number,international_phone_number,website&language=pt-BR&key=${API_KEY}`),
      placesNewGet(placeId, 'socialMediaLinks,websiteUri,nationalPhoneNumber,internationalPhoneNumber'),
    ]);

    // Legacy API result
    if (legacyData.status === 'fulfilled' && legacyData.value?.status === 'OK') {
      const r = legacyData.value.result || {};
      phone   = r.formatted_phone_number || r.international_phone_number || null;
      website = r.website || null;
      console.log('[details] legacy → phone:', phone, '| website:', website);
    } else {
      console.log('[details] legacy failed:', legacyData.reason?.message || legacyData.value?.status);
    }

    // New API result — Instagram from Google My Business "Perfis" tab
    if (newApiData.status === 'fulfilled' && newApiData.value) {
      const n = newApiData.value;
      console.log('[details] new API keys:', Object.keys(n).join(', '));
      if (n.socialMediaLinks?.length) {
        console.log('[details] socialMediaLinks:', JSON.stringify(n.socialMediaLinks));
        instagram = igFromLinks(n.socialMediaLinks);
        if (instagram) { igSource = 'gmb'; console.log('[details] IG from GMB:', instagram); }
      }
      if (!phone)   phone   = n.nationalPhoneNumber || n.internationalPhoneNumber || null;
      if (!website) website = n.websiteUri || null;
    } else {
      console.log('[details] new API failed:', newApiData.reason?.message);
    }

    // Fallback: scrape website for Instagram
    if (!instagram && website) {
      try {
        const siteUrl = website.startsWith('http') ? website : 'https://' + website;
        console.log('[details] scraping site:', siteUrl);
        const html = await fetchSite(siteUrl, 7000);
        instagram = igFromHTML(html);
        if (instagram) { igSource = 'site'; console.log('[details] IG from site:', instagram); }
        // Also try to get phone from site if missing
        if (!phone) {
          phone = phoneFromHTML(html);
          if (phone) console.log('[details] phone from site:', phone);
        }
      } catch(e) {
        console.log('[details] scrape error:', e.message);
      }
    }

    console.log('[details] RESULT → phone:', phone, '| site:', website, '| ig:', instagram);
    sendJSON({
      status: 'OK',
      result: { formatted_phone_number: phone, website, instagram, igSource }
    });
    return;
  }

  // ── /api/scrape ──────────────────────────────────────────────────────────
  if (pathname === '/api/scrape') {
    const targetUrl = (parsed.query.url || '').replace(/^http:\/\//, 'https://');
    if (!targetUrl.startsWith('https://')) { sendJSON({ body: '', error: 'invalid url' }, 400); return; }
    console.log('[scrape]', targetUrl.slice(0, 60));
    try {
      const body = await fetchSite(targetUrl, 8000);
      sendJSON({ body, status: 200 });
    } catch(e) {
      console.log('[scrape] error:', e.message);
      sendJSON({ body: '', status: 0, error: e.message });
    }
    return;
  }

  // ── /api/test ────────────────────────────────────────────────────────────
  // Quick health check — confirms server is running and API key is set
  if (pathname === '/api/test') {
    try {
      const data = await getJSON(
        `https://maps.googleapis.com/maps/api/geocode/json?address=São+Paulo,Brasil&region=BR&key=${API_KEY}`
      );
      sendJSON({ ok: true, geocode_status: data.status, port: PORT });
    } catch(e) {
      sendJSON({ ok: false, error: e.message }, 500);
    }
    return;
  }

  // ── Static files ─────────────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, decodeURIComponent(filePath));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + pathname); return; }
    const mime = MIME[path.extname(filePath)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   🎬  LEADFINDER — Vieira Marketing      ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log('  ║                                          ║');
  console.log('  ║   Porta: ' + PORT + '                              ║');
  console.log('  ║   API Key: ' + API_KEY.slice(0,12) + '...           ║');
  console.log('  ║                                          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
