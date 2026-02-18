// ==UserScript==
// @name         StreetEasy NYC Safety & Insights Overlay v2.1
// @namespace    https://streeteasy.com/
// @version      2.1.0
// @description  Cards: Crime+HPD. Details: Full insights UNDER "About Building"
// @author       heavenly
// @match        https://streeteasy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      geosearch.planninglabs.nyc
// @connect      data.cityofnewyork.us
// @connect      api.walkscore.com
// ==/UserScript==

(function() {
'use strict';

const CONFIG = {
  APP_TOKEN: '',
  WALKSCORE_KEY: '',
  CRIME_RADIUS_MILES: 0.25,
  CACHE_TTL_MS: 24*60*60*1000,
  ARREST_LOOKBACK_MONTHS: 6,
  CRIME_WEIGHTS: { F: 10, M: 3, V: 1 },
  DANGER_THRESHOLDS: [
    { max: 10, label: 'Low', emoji: '🟢', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
    { max: 30, label: 'Medium', emoji: '🟡', color: '#ca8a04', bg: '#fefce8', border: '#fef08a' },
    { max: 60, label: 'High', emoji: '🟠', color: '#ea580c', bg: '#fff7ed', border: '#fed7aa' },
    { max: Infinity, label: 'Severe', emoji: '🔴', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
  ],
};

// APIs
const NYPD_YTD = 'https://data.cityofnewyork.us/resource/uip8-fykc.json';
const NYPD_HIST = 'https://data.cityofnewyork.us/resource/8h9b-rp9u.json';
const HPD_COMPLAINTS = 'https://data.cityofnewyork.us/resource/uwyv-629c.json';
const HPD_VIOLATIONS = 'https://data.cityofnewyork.us/resource/wvxf-dwi5.json';
const NYC_311 = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json';
const DOB_VIOLATIONS = 'https://data.cityofnewyork.us/resource/h2n3-pwk2.json';

// ─── UTILS ────────────────────────────────────────────────────────────────
function lsKey(key) { return `se_v21_${key}`; }
function getCache(key) {
  try {
    const raw = localStorage.getItem(lsKey(key));
    if (!raw) return null;
    const {ts, data} = JSON.parse(raw);
    return Date.now() - ts < CONFIG.CACHE_TTL_MS ? data : null;
  } catch { return null; }
}
function setCache(key, data) {
  try { localStorage.setItem(lsKey(key), JSON.stringify({ts: Date.now(), data})); } catch {}
}

function gmFetch(url) {
  return new Promise(resolve => {
    GM_xmlhttpRequest({
      method: 'GET', url, timeout: 10000,
      onload(r) {
        try {
          const data = JSON.parse(r.responseText);
          resolve(Array.isArray(data) ? data : null);
        } catch { resolve(null); }
      },
      onerror: () => resolve(null),
      ontimeout: () => resolve(null)
    });
  });
}

// ─── PAGE DETECTION ───────────────────────────────────────────────────────
function isCardPage() { return !!document.querySelector('[data-testid="listing-card"]'); }
function isDetailPage() {
  return window.location.pathname.match(/\/building\/[^\/]+\/[^\/]+/) ||
         window.location.pathname.match(/\/rental\/\d+/);
}

// ─── GEOCODING & COORDS ───────────────────────────────────────────────────
async function geocodeAddress(address) {
  const ck = `geo_${address}`;
  if (getCache(ck)) return getCache(ck);

  const url = `https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(address + ', NY')}&size=1`;
  const data = await gmFetch(url);
  const feat = data?.features?.[0];
  if (!feat) return null;

  const [lon, lat] = feat.geometry.coordinates;
  const result = {lat, lon};
  setCache(ck, result);
  return result;
}

function extractPageCoords() {
  // Multiple selectors for StreetEasy map URLs
  const mapSelectors = [
    'img[src*="maps.googleapis.com"]',
    'img[src*="staticmap"]',
    '[style*="maps.googleapis"]',
    '.map img'
  ];

  for (const sel of mapSelectors) {
    const img = document.querySelector(sel);
    if (img?.src) {
      try {
        const url = new URL(img.src);
        const center = url.searchParams.get('center') || url.searchParams.get('q');
        if (center) {
          const match = center.match(/(-?\d+\.?\d*),?\s*(-?\d+\.?\d*)/);
          if (match) return { lat: parseFloat(match[1]), lon: parseFloat(match[2]) };
        }
      } catch {}
    }
  }
  return null;
}

// ─── DATA FETCHERS ────────────────────────────────────────────────────────
async function fetchCrime(lat, lon) {
  const ck = `crime_${lat.toFixed(4)}_${lon.toFixed(4)}`;
  if (getCache(ck)) return getCache(ck);

  const d = CONFIG.CRIME_RADIUS_MILES / 69;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CONFIG.ARREST_LOOKBACK_MONTHS);
  const cutoffStr = cutoff.toISOString().split('T')[0] + 'T00:00:00.000';

  const where = encodeURIComponent(
    `latitude > ${(lat-d).toFixed(6)} AND latitude < ${(lat+d).toFixed(6)} ` +
    `AND longitude > ${(lon-d).toFixed(6)} AND longitude < ${(lon+d).toFixed(6)} ` +
    `AND arrest_date >= '${cutoffStr}'`
  );

  const urls = [
    `${NYPD_YTD}?$where=${where}&$select=law_cat_cd&$limit=2000`,
    `${NYPD_HIST}?$where=${where}&$select=law_cat_cd&$limit=2000`
  ];

  const results = await Promise.all(urls.map(gmFetch));
  const arrests = results.filter(Boolean).flat();

  let score = 0, breakdown = {F:0,M:0,V:0};
  for (const a of arrests) {
    const cat = (a.law_cat_cd||'').trim().toUpperCase();
    const weight = CONFIG.CRIME_WEIGHTS[cat] || 1;
    score += weight;
    if (cat in breakdown) breakdown[cat]++;
  }

  const result = {
    score: score / CONFIG.ARREST_LOOKBACK_MONTHS,
    total: arrests.length,
    breakdown,
    months: CONFIG.ARREST_LOOKBACK_MONTHS
  };
  setCache(ck, result);
  return result;
}

async function fetchHPD(address) {
  const ck = `hpd_${address}`;
  if (getCache(ck)) return getCache(ck);

  const parsed = address.match(/^(\d+)\s+(.+)/);
  if (!parsed) return {complaints:0, violations:0, openViolations:0};

  const [_, hnum, street] = parsed;
  const where = encodeURIComponent(`housenumber='${hnum}' AND streetname LIKE '${street.toUpperCase()}%'`);
  const token = CONFIG.APP_TOKEN ? `&$$app_token=${CONFIG.APP_TOKEN}` : '';

  const [complaints, violations] = await Promise.all([
    gmFetch(`${HPD_COMPLAINTS}?$where=${where}&$limit=100${token}`),
    gmFetch(`${HPD_VIOLATIONS}?$where=${where}&$limit=100${token}`)
  ]);

  const openViolations = (violations||[]).filter(v =>
    (v.currentstatus||'').toUpperCase().includes('OPEN')
  ).length;

  const result = {
    complaints: complaints?.length || 0,
    violations: violations?.length || 0,
    openViolations,
    pest: complaints?.filter(c =>
      JSON.stringify(c).match(/ROACH|PEST|BEDBUG/i)
    ).length || 0
  };
  setCache(ck, result);
  return result;
}

async function fetchNoise(lat, lon) {
  const ck = `noise_${lat.toFixed(4)}_${lon.toFixed(4)}`;
  if (getCache(ck)) return getCache(ck);

  const d = 0.25 / 69;
  const where = encodeURIComponent(
    `latitude > ${(lat-d).toFixed(6)} AND latitude < ${(lat+d).toFixed(6)} ` +
    `AND longitude > ${(lon-d).toFixed(6)} AND longitude < ${(lon+d).toFixed(6)} ` +
    `AND created_date > '2025-08-01' AND complaint_type LIKE '%NOISE%'`
  );

  const data = await gmFetch(`${NYC_311}?$where=${where}&$limit=100`);
  const result = data?.length || 0;
  setCache(ck, result);
  return result;
}

async function fetchDOB(address) {
  const ck = `dob_${address}`;
  if (getCache(ck)) return getCache(ck);

  const parsed = address.match(/^(\d+)\s+(.+)/);
  if (!parsed) return 0;

  const [_, hnum, street] = parsed;
  const where = encodeURIComponent(
    `housenumber='${hnum}' AND street_name LIKE '${street.split(' ')[0].toUpperCase()}%'`
  );

  const data = await gmFetch(`${DOB_VIOLATIONS}?$where=${where}&$limit=50`);
  const result = data?.filter(v => (v.status||'').includes('OPEN')).length || 0;
  setCache(ck, result);
  return result;
}

// ─── PAGE DATA EXTRACTORS ─────────────────────────────────────────────────
function getDetailAddress() {
  // Multiple selectors for address
  const selectors = [
    'p[class*="address"]',
    '[class*="AboutBuildingSection"] p',
    '[class*="street-address"]',
    '.building-address',
    '[data-testid*="address"]'
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.textContent?.includes('NY')) return el.textContent.trim();
  }
  return null;
}

// Replace the getListingAgeDays function with this fixed version:

function getListingAgeDays() {
  // Get ALL text nodes and search for age patterns
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let node;
  while (node = walker.nextNode()) {
    const text = node.textContent.toLowerCase();
    const match = text.match(/(\d+)\s*(day|week|month)s?/);
    if (match) {
      const num = parseInt(match[1]);
      if (match[2] === 'week') return num * 7;
      if (match[2] === 'month') return num * 30;
      return num;
    }
  }

  // Also check common element selectors
  const els = document.querySelectorAll('[class*="day"],[class*="listed"],[class*="market"]');
  for (const el of els) {
    const text = el.textContent.toLowerCase();
    const match = text.match(/(\d+)\s*(day|week|month)s?/);
    if (match) {
      const num = parseInt(match[1]);
      if (match[2] === 'week') return num * 7;
      if (match[2] === 'month') return num * 30;
      return num;
    }
  }

  return null;
}


function getRentPrice() {
  const priceSelectors = [
    '[class*="rentPrice"]', '[class*="monthlyRent"]', '[data-testid*="price"]',
    '.price', '[class*="Price"] span'
  ];

  for (const sel of priceSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const match = el.textContent.match(/\$(\d+(?:,\d{3})+)/);
      if (match) return parseInt(match[1].replace(/,/g,''));
    }
  }
  return null;
}

// ─── UI ──────────────────────────────────────────────────────────────────
function getDangerLevel(score) {
  for (const t of CONFIG.DANGER_THRESHOLDS) if (score <= t.max) return t;
  return CONFIG.DANGER_THRESHOLDS[3];
}

function buildCardBadge(crime, hpd) {
  const danger = getDangerLevel(crime?.score || 0);
  return `
    <div class="se-card-badge" style="
      margin:8px 0;padding:10px 12px;background:${danger.bg};
      border:1px solid ${danger.border};border-radius:8px;font-size:13px;
    ">
      <div style="display:flex;align-items:center;gap:6px;font-weight:700;color:${danger.color};font-size:14px;">
        ${danger.emoji} ${danger.label}
      </div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px;">
        ${crime?.total || 0} arrests · ${hpd?.complaints || 0}c/${hpd?.violations || 0}v
        ${hpd?.openViolations ? ` ⚠️ ${hpd.openViolations} open` : ''}
      </div>
    </div>
  `;
}

function buildDetailPanel(crime, hpd, noise, dob, ageDays, rentComp) {
  const danger = getDangerLevel(crime?.score || 0);

  const cards = [];
  if (crime?.total) cards.push(`🟢${crime.total} arrests`);
  if (hpd?.openViolations) cards.push(`🔴${hpd.openViolations} open HPD`);
  if (noise > 5) cards.push(`🔊${noise} noise calls`);
  if (dob > 0) cards.push(`🏗️${dob} DOB issues`);

  const statusClass = ageDays > 60 ? '🔴' : ageDays > 30 ? '🟡' : '🟢';

  return `
    <div class="se-insights-panel" style="
      margin:20px 0;padding:24px;background:${danger.bg};
      border:2px solid ${danger.border};border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.12);
      font-family:system-ui,-apple-system,sans-serif;
    ">
      <div style="font-size:20px;font-weight:700;color:${danger.color};margin-bottom:16px;display:flex;gap:8px;align-items:center;">
        ${danger.emoji} ${danger.label} Neighborhood Insights
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;">
        <div style="background:rgba(255,255,255,0.7);padding:16px;border-radius:12px;">
          <div style="font-weight:600;margin-bottom:8px;color:#374151;">Crime (6mo)</div>
          <div style="font-size:18px;font-weight:700;color:${danger.color};">${crime?.total || 0}</div>
          <div style="font-size:12px;color:#6b7280;">${crime?.breakdown?.F || 0}F/${crime?.breakdown?.M || 0}M</div>
        </div>

        <div style="background:rgba(255,255,255,0.7);padding:16px;border-radius:12px;">
          <div style="font-weight:600;margin-bottom:8px;color:#374151;">HPD Record</div>
          <div style="font-size:18px;font-weight:700;color:${hpd?.openViolations ? '#dc2626' : '#22c55e'};">
            ${hpd?.openViolations || 0} open
          </div>
          <div style="font-size:12px;color:#6b7280;">${hpd?.complaints || 0}c/${hpd?.violations || 0}v total</div>
          ${hpd?.pest ? `<div style="color:#f97316;font-size:11px;">🪳 ${hpd.pest} pest</div>` : ''}
        </div>

        ${noise > 0 ? `
        <div style="background:rgba(255,255,255,0.7);padding:16px;border-radius:12px;">
          <div style="font-weight:600;margin-bottom:8px;">311 Noise</div>
          <div style="font-size:18px;font-weight:700;color:#f97316;">${noise}</div>
          <div style="font-size:12px;color:#6b7280;">past 6 months</div>
        </div>` : ''}

        ${dob > 0 ? `
        <div style="background:rgba(255,255,255,0.7);padding:16px;border-radius:12px;">
          <div style="font-weight:600;margin-bottom:8px;">DOB Violations</div>
          <div style="font-size:18px;font-weight:700;color:#dc2626;">${dob}</div>
          <div style="font-size:12px;color:#6b7280;">active issues</div>
        </div>` : ''}

        ${ageDays !== null ? `
        <div style="background:rgba(255,255,255,0.7);padding:16px;border-radius:12px;">
          <div style="font-weight:600;margin-bottom:8px;">On Market</div>
          <div style="font-size:18px;font-weight:700;color:${ageDays>60?'#dc2626':ageDays>30?'#f97316':'#22c55e'};">
            ${ageDays} days
          </div>
        </div>` : ''}
      </div>

      <div style="margin-top:20px;padding-top:16px;border-top:1px solid ${danger.border};font-size:12px;color:#9ca3af;text-align:center;">
        NYPD•HPD•DOB•311 data • Refreshes daily
      </div>
    </div>
  `;
}

// ─── INJECTION ───────────────────────────────────────────────────────────
function injectCardOverlay(card, crime, hpd) {
  if (card.querySelector('.se-card-badge')) return;
  const html = buildCardBadge(crime, hpd);
  const div = document.createElement('div');
  div.innerHTML = html;
  const badge = div.firstElementChild;

  // Find price section and insert after
  const priceParent = card.querySelector('[class*="price"], [class*="Price"]')?.closest('div[class*="row"], div[class*="flex"]');
  if (priceParent) {
    priceParent.after(badge);
  } else {
    card.appendChild(badge);
  }
}

function injectDetailPanel(crime, hpd, noise, dob, ageDays) {
  if (document.querySelector('.se-insights-panel')) return;

  const html = buildDetailPanel(crime, hpd, noise, dob, ageDays);
  const div = document.createElement('div');
  div.innerHTML = html;
  const panel = div.firstElementChild;

  // **NEW: Target right under "About the Building"**
  const aboutSection = Array.from(document.querySelectorAll('section, div[class*="About"], [class*="building"]'))
    .find(el => el.textContent.toLowerCase().includes('about') ||
                el.textContent.toLowerCase().includes('building'));

  if (aboutSection) {
    aboutSection.after(panel);
    console.log('[SE Insights] Panel injected under About section');
    return;
  }

  // Fallback: after first main content section
  const mainContent = document.querySelector('main, [class*="main"], [class*="content"]');
  if (mainContent?.children[0]) {
    mainContent.children[0].after(panel);
    console.log('[SE Insights] Fallback injection');
  }
}

// ─── PROCESSORS ──────────────────────────────────────────────────────────
async function processCard(card) {
  const address = Array.from(card.querySelectorAll('[class*="address"], [class*="Address"]'))
    .map(el => el.textContent.trim().replace(/#.*/, ''))[0];

  if (!address) return;

  const coords = await geocodeAddress(address);
  const [crime, hpd] = await Promise.all([
    coords ? fetchCrime(coords.lat, coords.lon) : null,
    fetchHPD(address)
  ]);

  injectCardOverlay(card, crime, hpd);
}

async function processDetailPage() {
  const address = getDetailAddress();
  if (!address) {
    console.log('[SE Insights] No address found');
    return;
  }

  console.log('[SE Insights] Processing detail page:', address);

  const coords = extractPageCoords() || await geocodeAddress(address);
  if (!coords) {
    console.log('[SE Insights] No coordinates');
    return;
  }

  const [crime, hpd, noise, dob, ageDays] = await Promise.all([
    fetchCrime(coords.lat, coords.lon),
    fetchHPD(address),
    fetchNoise(coords.lat, coords.lon),
    fetchDOB(address),
    Promise.resolve(getListingAgeDays())
  ]);

  injectDetailPanel(crime, hpd, noise, dob, ageDays);
  console.log('[SE Insights] Detail panel complete');
}

// ─── OBSERVER & INIT ─────────────────────────────────────────────────────
const observer = new MutationObserver((mutations) => {
  if (isDetailPage()) {
    // Retry every 2s until content loads
    clearTimeout(window.seDetailTimeout);
    window.seDetailTimeout = setTimeout(processDetailPage, 2000);
  }

  // Cards
  mutations.forEach(m => {
    m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.matches?.('[data-testid="listing-card"]')) processCard(node);
      node.querySelectorAll?.('[data-testid="listing-card"]').forEach(processCard);
    });
  });
});

function init() {
  observer.observe(document.body, {childList: true, subtree: true});

  if (isCardPage()) {
    document.querySelectorAll('[data-testid="listing-card"]').forEach((c,i) =>
      setTimeout(() => processCard(c), i*200)
    );
  }

  if (isDetailPage()) {
    setTimeout(processDetailPage, 1500);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  setTimeout(init, 1000);
}

})();
