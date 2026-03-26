const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;
const API_KEY = 'AIzaSyARkQ9E3BDpoaAJG_0AFtmn_Z51E61GZC0';

// ── Generic HTTPS GET → parsed JSON ─────────────────────────────────────────
function httpsGetJSON(targetUrl) {
  return new Promise((resolve, reject) => {
    https.get(targetUrl, { headers: { 'Accept': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch(e) { reject(new Error('JSON parse: ' + d.substring(0, 80))); }
      });
    }).on('error', reject);
  });
}

// ── Places API (New) GET via places.googleapis.com ──────────────────────────
function placesNewAPI(placeId, fieldMask) {
  return new Promise((resolve) => {
    // The new API uses "places/PLACE_ID" format
    const reqPath = '/v1/places/' + placeId;
    const opts = {
      hostname: 'places.googleapis.com',
      path:     reqPath,
      method:   'GET',
      headers: {
        'X-Goog-Api-Key':   API_KEY,
        'X-Goog-FieldMask': fieldMask,
        'Accept':           'application/json',
      }
    };
    let d = '';
    const req = https.request(opts, res => {
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          console.log(`  [GMB] placeId=${placeId.substring(0,20)} status=${res.statusCode} keys=${Object.keys(parsed).join(',')}`);
          resolve(parsed);
        } catch { resolve({}); }
      });
    });
    req.on('error', e => { console.warn('  [GMB] error:', e.message); resolve({}); });
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.end();
  });
}

// ── Fetch website HTML for Instagram scraping ────────────────────────────────
function fetchWebsite(targetUrl, ms = 7000) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    if (!parsed.hostname) { reject(new Error('invalid url')); return; }
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.path || '/',
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
    const req = https.request(opts, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : 'https://' + parsed.hostname + res.headers.location;
        fetchWebsite(loc, ms).then(resolve).catch(reject);
        return;
      }
      let d = '';
      res.on('data', c => { if (d.length < 400000) d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── Extract Instagram from socialMediaLinks array (Places API New) ────────────
function igFromSocialLinks(links) {
  if (!Array.isArray(links)) return null;
  const SKIP = new Set(['p','reel','reels','explore','stories','accounts','share','sharer']);
  for (const link of links) {
    const u = (typeof link === 'string' ? link : (link.uri || link.url || '')).toLowerCase();
    if (u.includes('instagram.com/')) {
      const m = u.match(/instagram\.com\/([a-z0-9._]{2,30})/i);
      if (m && m[1] && !SKIP.has(m[1].toLowerCase())) {
        return m[1].toLowerCase();
      }
    }
  }
  return null;
}

// ── Extract Instagram from HTML ───────────────────────────────────────────────
function igFromHTML(html) {
  const SKIP = new Set(['p','reel','reels','stories','explore','accounts','_i',
    'sharer','share','direct','tv','ar','about','legal','help','blog','press',
    'api','oauth','challenge','login','signup','instagram','privacy','safety']);
  const rx = /instagram\.com\/([a-zA-Z0-9._]{2,30})(?:["'\/?<\s]|$)/g;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const h = m[1].replace(/\/$/, '').toLowerCase();
    if (!SKIP.has(h) && !h.startsWith('_') && h.length >= 3) return h;
  }
  return null;
}

// ── MIME ─────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // ── /api/geocode ──────────────────────────────────────────────────────────
  if (pathname === '/api/geocode') {
    const address = parsed.query.address || '';
    try {
      const { data } = await httpsGetJSON(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=BR&key=${API_KEY}`
      );
      json(data);
    } catch(e) { json({ status: 'ERROR', error_message: e.message }, 500); }
    return;
  }

  // ── /api/places ───────────────────────────────────────────────────────────
  if (pathname === '/api/places') {
    const q = parsed.query;
    let apiUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q.query||'')}&location=${q.lat},${q.lng}&radius=${q.radius||10000}&region=BR&language=pt-BR&key=${API_KEY}`;
    if (q.pagetoken) apiUrl += `&pagetoken=${encodeURIComponent(q.pagetoken)}`;
    try {
      const { data } = await httpsGetJSON(apiUrl);
      json(data);
    } catch(e) { json({ status: 'ERROR', error_message: e.message }, 500); }
    return;
  }

  // ── /api/details ──────────────────────────────────────────────────────────
  // Strategy:
  //   1. Legacy Places API  → phone + website (reliable)
  //   2. Places API (New)   → socialMediaLinks = Instagram from Google My Business
  //   3. Scrape website HTML → Instagram fallback if not in GMB
  if (pathname === '/api/details') {
    const placeId = parsed.query.place_id || '';
    if (!placeId) { json({ status: 'ERROR', error_message: 'missing place_id' }, 400); return; }

    console.log(`\n[details] place_id=${placeId.substring(0,30)}`);

    let phone     = null;
    let website   = null;
    let instagram = null;
    let igSource  = null;

    // ── Step 1: Legacy API → phone + website ─────────────────────────────────
    try {
      const legUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=formatted_phone_number,international_phone_number,website&language=pt-BR&key=${API_KEY}`;
      const { data: leg } = await httpsGetJSON(legUrl);
      console.log(`  [legacy] status=${leg.status}`);
      if (leg.status === 'OK' && leg.result) {
        phone   = leg.result.formatted_phone_number
               || leg.result.international_phone_number
               || null;
        website = leg.result.website || null;
        console.log(`  [legacy] phone=${phone} website=${website}`);
      }
    } catch(e) { console.warn('  [legacy] error:', e.message); }

    // ── Step 2: New API → socialMediaLinks (Instagram from GMB "Perfis") ─────
    try {
      const newData = await placesNewAPI(placeId, 'socialMediaLinks,websiteUri,nationalPhoneNumber,internationalPhoneNumber');
      if (newData.socialMediaLinks && newData.socialMediaLinks.length > 0) {
        console.log(`  [new api] socialMediaLinks:`, JSON.stringify(newData.socialMediaLinks));
        instagram = igFromSocialLinks(newData.socialMediaLinks);
        if (instagram) { igSource = 'gmb'; console.log(`  [new api] IG found: @${instagram}`); }
      } else {
        console.log(`  [new api] no socialMediaLinks`);
      }
      // Fill phone/website from new API if legacy didn't return
      if (!phone)   phone   = newData.nationalPhoneNumber || newData.internationalPhoneNumber || null;
      if (!website) website = newData.websiteUri || null;
    } catch(e) { console.warn('  [new api] error:', e.message); }

    // ── Step 3: Scrape website → Instagram fallback ───────────────────────────
    if (!instagram && website) {
      try {
        const siteUrl = website.startsWith('http') ? website : 'https://' + website;
        console.log(`  [scrape] fetching ${siteUrl}`);
        const { body } = await fetchWebsite(siteUrl, 6000);
        instagram = igFromHTML(body);
        if (instagram) { igSource = 'site'; console.log(`  [scrape] IG found: @${instagram}`); }
        else { console.log(`  [scrape] no IG in HTML (${body.length} bytes)`); }
      } catch(e) { console.warn('  [scrape] error:', e.message); }
    }

    console.log(`  [result] phone=${phone} website=${website} instagram=${instagram}`);

    json({
      status: 'OK',
      result: { formatted_phone_number: phone, website, instagram, igSource }
    });
    return;
  }

  // ── /api/scrape ───────────────────────────────────────────────────────────
  if (pathname === '/api/scrape') {
    const targetUrl = (parsed.query.url || '').replace(/^http:\/\//, 'https://');
    if (!targetUrl.startsWith('https://')) { json({ body: '', error: 'invalid url' }, 400); return; }
    try {
      const result = await fetchWebsite(targetUrl, 8000);
      json({ body: result.body || '', status: result.status });
    } catch(e) {
      json({ body: '', status: 0, error: e.message });
    }
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + pathname); return; }
    const mime = MIME[path.extname(filePath)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │    🎬  LEADFINDER — Vieira Marketing     │');
  console.log('  ├──────────────────────────────────────────┤');
  console.log('  │                                          │');
  console.log(`  │    Acesse: http://localhost:${PORT}           │`);
  console.log('  │                                          │');
  console.log('  │    Ctrl + C para encerrar                │');
  console.log('  └──────────────────────────────────────────┘');
  console.log('');
});
