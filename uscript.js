// ==UserScript==
// @name         StreetEasy NYC Safety & Insights Overlay
// @namespace    https://streeteasy.com/
// @version      2.2.0
// @description  Cards: Crime+HPD. Details: Full insights panel under About Building
// @author       heavenly
// @match        https://streeteasy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      geosearch.planninglabs.nyc
// @connect      data.cityofnewyork.us
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
    { max: 10,       label: 'Low',    emoji: '🟢', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
    { max: 30,       label: 'Medium', emoji: '🟡', color: '#ca8a04', bg: '#fefce8', border: '#fef08a' },
    { max: 60,       label: 'High',   emoji: '🟠', color: '#ea580c', bg: '#fff7ed', border: '#fed7aa' },
    { max: Infinity, label: 'Severe', emoji: '🔴', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
  ],
};

const NYPD_YTD      = 'https://data.cityofnewyork.us/resource/uip8-fykc.json';
const NYPD_HIST     = 'https://data.cityofnewyork.us/resource/8h9b-rp9u.json';
const HPD_COMP      = 'https://data.cityofnewyork.us/resource/uwyv-629c.json';
const HPD_VIOL      = 'https://data.cityofnewyork.us/resource/wvxf-dwi5.json';
const NYC_311       = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json';
const DOB_VIOL      = 'https://data.cityofnewyork.us/resource/h2n3-pwk2.json';

// ─── CACHE ────────────────────────────────────────────────────────────────
function lsKey(k) { return `se_v22_${k}`; }

function getCache(key) {
  try {
    const raw = localStorage.getItem(lsKey(key));
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    return Date.now() - ts < CONFIG.CACHE_TTL_MS ? data : null;
  } catch { return null; }
}

function setCache(key, data) {
  try { localStorage.setItem(lsKey(key), JSON.stringify({ ts: Date.now(), data })); } catch {}
}

// ─── NETWORK ──────────────────────────────────────────────────────────────
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
      onerror:   () => resolve(null),
      ontimeout: () => resolve(null),
    });
  });
}

// ─── PAGE DETECTION ───────────────────────────────────────────────────────
function isDetailPage() {
  return /\/building\/[^/]+\/[^/]+|\/rental\/\d+/.test(window.location.pathname);
}

// ─── GEOCODING ────────────────────────────────────────────────────────────
async function geocodeAddress(address) {
  const ck = `geo_${address}`;
  const cached = getCache(ck);
  if (cached) return cached;

  const url = `https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(address + ', NY')}&size=1`;
  const data = await gmFetch(url);
  const feat = data?.features?.[0];
  if (!feat) return null;

  const [lon, lat] = feat.geometry.coordinates;
  const result = { lat, lon };
  setCache(ck, result);
  return result;
}

function extractPageCoords() {
  const img = document.querySelector('img[src*="maps.googleapis.com"]');
  if (!img?.src) return null;
  try {
    const url = new URL(img.src);
    const center = url.searchParams.get('center');
    if (center) {
      const m = center.match(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
      if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
    }
  } catch {}
  return null;
}

// ─── CRIME ────────────────────────────────────────────────────────────────
async function fetchCrime(lat, lon) {
  const ck = `crime_${lat.toFixed(4)}_${lon.toFixed(4)}`;
  const cached = getCache(ck);
  if (cached) return cached;

  const d = CONFIG.CRIME_RADIUS_MILES / 69;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CONFIG.ARREST_LOOKBACK_MONTHS);
  const cutStr = cutoff.toISOString().split('T')[0] + 'T00:00:00.000';

  const where = encodeURIComponent(
    `latitude > ${(lat-d).toFixed(6)} AND latitude < ${(lat+d).toFixed(6)} ` +
    `AND longitude > ${(lon-d).toFixed(6)} AND longitude < ${(lon+d).toFixed(6)} ` +
    `AND arrest_date >= '${cutStr}'`
  );

  const results = await Promise.all([
    gmFetch(`${NYPD_YTD}?$where=${where}&$select=law_cat_cd&$limit=2000`),
    gmFetch(`${NYPD_HIST}?$where=${where}&$select=law_cat_cd&$limit=2000`),
  ]);

  const arrests = results.filter(Boolean).flat();
  let score = 0;
  const breakdown = { F: 0, M: 0, V: 0 };

  for (const a of arrests) {
    const cat = (a.law_cat_cd || '').trim().toUpperCase();
    score += CONFIG.CRIME_WEIGHTS[cat] || 1;
    if (cat in breakdown) breakdown[cat]++;
  }

  const result = {
    score: score / CONFIG.ARREST_LOOKBACK_MONTHS,
    total: arrests.length,
    breakdown,
  };
  setCache(ck, result);
  return result;
}

// ─── HPD ──────────────────────────────────────────────────────────────────
async function fetchHPD(address) {
  const ck = `hpd_${address}`;
  const cached = getCache(ck);
  if (cached) return cached;

  const m = address.match(/^(\d+[\w-]*)\s+(.+)/);
  if (!m) return { complaints: 0, violations: 0, openViolations: 0, pest: 0 };

  const hnum   = m[1];
  const street = m[2].replace(/,.*/, '').trim().toUpperCase();
  const where  = encodeURIComponent(`housenumber='${hnum}' AND streetname LIKE '${street}%'`);
  const token  = CONFIG.APP_TOKEN ? `&$$app_token=${CONFIG.APP_TOKEN}` : '';

  const [complaints, violations] = await Promise.all([
    gmFetch(`${HPD_COMP}?$where=${where}&$limit=100${token}`),
    gmFetch(`${HPD_VIOL}?$where=${where}&$limit=100${token}`),
  ]);

  const openViolations = (violations || []).filter(v =>
    (v.currentstatus || '').toUpperCase().match(/OPEN|NOT COMPLIED|UNABLE/)
  ).length;

  const pest = (complaints || []).filter(c =>
    JSON.stringify(c).match(/ROACH|PEST|BED.?BUG|MICE|RAT|VERMIN/i)
  ).length;

  const result = {
    complaints:     complaints?.length || 0,
    violations:     violations?.length || 0,
    openViolations,
    pest,
  };
  setCache(ck, result);
  return result;
}

// ─── NOISE ────────────────────────────────────────────────────────────────
async function fetchNoise(lat, lon) {
  const ck = `noise_${lat.toFixed(4)}_${lon.toFixed(4)}`;
  const cached = getCache(ck);
  if (cached !== null) return cached;

  const d = 0.25 / 69;
  const where = encodeURIComponent(
    `latitude > ${(lat-d).toFixed(6)} AND latitude < ${(lat+d).toFixed(6)} ` +
    `AND longitude > ${(lon-d).toFixed(6)} AND longitude < ${(lon+d).toFixed(6)} ` +
    `AND created_date > '2025-08-01' AND complaint_type LIKE '%NOISE%'`
  );

  const data = await gmFetch(`${NYC_311}?$where=${where}&$limit=200`);
  const result = data?.length || 0;
  setCache(ck, result);
  return result;
}

// ─── DOB ──────────────────────────────────────────────────────────────────
async function fetchDOB(address) {
  const ck = `dob_${address}`;
  const cached = getCache(ck);
  if (cached !== null) return cached;

  const m = address.match(/^(\d+[\w-]*)\s+(.+)/);
  if (!m) return 0;

  const hnum  = m[1];
  const first = m[2].split(' ')[0].toUpperCase();
  const where = encodeURIComponent(
    `housenumber='${hnum}' AND street_name LIKE '${first}%'`
  );

  const data = await gmFetch(`${DOB_VIOL}?$where=${where}&$limit=50`);
  const result = data?.filter(v => (v.status || '').toUpperCase().includes('OPEN')).length || 0;
  setCache(ck, result);
  return result;
}

// ─── PAGE DATA EXTRACTORS ─────────────────────────────────────────────────
function getDetailAddress() {
  const selectors = [
    '[class*="AboutBuildingSection"] p',
    'p[class*="address"]',
    '[class*="buildingAddress"]',
    '[class*="street-address"]',
    '[data-testid*="address"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = el?.textContent?.trim();
    if (text && /\d/.test(text)) return text;
  }
  return null;
}

function getListingAgeDays() {
  // Use TreeWalker - no jQuery :contains()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.toLowerCase().trim();
    if (text.length < 3 || text.length > 60) continue;
    const match = text.match(/(\d+)\s*(day|week|month)s?\s*(on market|listed|ago)?/);
    if (match) {
      const num = parseInt(match[1]);
      if (match[2] === 'week')  return num * 7;
      if (match[2] === 'month') return num * 30;
      if (num > 0 && num < 1000) return num;
    }
  }
  return null;
}

// ─── SCORING ──────────────────────────────────────────────────────────────
function getDangerLevel(score) {
  for (const t of CONFIG.DANGER_THRESHOLDS) if (score <= t.max) return t;
  return CONFIG.DANGER_THRESHOLDS[3];
}

// ─── CARD UI ──────────────────────────────────────────────────────────────
function buildCardBadge(crime, hpd) {
  if (!crime && !hpd) return '';
  const danger = getDangerLevel(crime?.score || 0);

  const fBadge = crime?.breakdown?.F > 0 ? `<span style="background:#dc2626;color:#fff;border-radius:4px;padding:1px 5px;font-size:10px;">${crime.breakdown.F}F</span> ` : '';
  const mBadge = crime?.breakdown?.M > 0 ? `<span style="background:#f97316;color:#fff;border-radius:4px;padding:1px 5px;font-size:10px;">${crime.breakdown.M}M</span> ` : '';
  const hpdBadge = hpd?.openViolations > 0
    ? `<span style="background:#dc2626;color:#fff;border-radius:4px;padding:1px 5px;font-size:10px;">${hpd.openViolations} HPD open</span>`
    : `<span style="color:#22c55e;font-size:10px;">✓ HPD clean</span>`;

  return `
    <div class="se-card-badge" style="
      margin:8px 0 4px;padding:8px 12px;
      background:${danger.bg};border:1px solid ${danger.border};
      border-radius:8px;font-family:system-ui,sans-serif;font-size:13px;
    ">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;">
        <span style="font-weight:700;color:${danger.color};">
          ${danger.emoji} ${danger.label} · ${crime?.total || 0} arrests
        </span>
        <div style="display:flex;gap:4px;align-items:center;">
          ${fBadge}${mBadge}${hpdBadge}
          ${hpd?.pest ? `<span style="font-size:10px;color:#f97316;">🪳${hpd.pest}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

// ─── DETAIL PANEL UI ──────────────────────────────────────────────────────
function buildDetailPanel(crime, hpd, noise, dob, ageDays) {
  const danger = getDangerLevel(crime?.score || 0);

  function card(emoji, title, value, sub, valueColor) {
    return `
      <div style="background:rgba(255,255,255,0.75);padding:14px 16px;border-radius:10px;min-width:0;">
        <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">${emoji} ${title}</div>
        <div style="font-size:22px;font-weight:700;color:${valueColor || '#111827'};">${value}</div>
        ${sub ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px;">${sub}</div>` : ''}
      </div>
    `;
  }

  const crimeColor = danger.color;
  const ageColor   = ageDays > 60 ? '#dc2626' : ageDays > 30 ? '#f97316' : '#16a34a';
  const noiseColor = noise > 20 ? '#dc2626' : noise > 5 ? '#f97316' : '#16a34a';
  const dobColor   = dob > 0 ? '#dc2626' : '#16a34a';
  const hpdColor   = hpd?.openViolations > 0 ? '#dc2626' : '#16a34a';

  return `
    <div class="se-insights-panel" style="
      margin:20px 0;padding:20px 24px 16px;
      background:${danger.bg};border:2px solid ${danger.border};border-radius:14px;
      box-shadow:0 4px 20px rgba(0,0,0,0.08);
      font-family:system-ui,-apple-system,sans-serif;
    ">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
        <span style="font-size:18px;font-weight:700;color:${danger.color};">
          ${danger.emoji} ${danger.label} Danger — Neighborhood Insights
        </span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;">
        ${card('🚨','Arrests (6mo)', crime?.total || 0,
          `${crime?.breakdown?.F||0}F · ${crime?.breakdown?.M||0}M · ${crime?.score?.toFixed(1)||0} pts/mo`, crimeColor)}

        ${card('🏠','HPD Open', hpd?.openViolations || 0,
          `${hpd?.complaints||0} complaints · ${hpd?.violations||0} total`,
          hpdColor)}

        ${hpd?.pest > 0 ? card('🪳','Pest Reports', hpd.pest, 'on record', '#f97316') : ''}

        ${card('🔊','311 Noise', noise, 'past 6 months', noiseColor)}

        ${card('🏗️','DOB Violations', dob, 'active', dobColor)}

        ${ageDays !== null ? card('📅','Days Listed', ageDays, ageDays > 60 ? '⚠️ stale listing' : ageDays > 30 ? 'worth checking' : 'fresh', ageColor) : ''}
      </div>

      <div style="margin-top:14px;font-size:11px;color:#9ca3af;display:flex;justify-content:space-between;align-items:center;">
        <span>NYPD • HPD • DOB • NYC 311 • Refreshes every 24h</span>
        <a href="https://hpdonline.nyc.gov/hpdonline/" target="_blank"
           style="color:#0041D9;text-decoration:none;font-size:11px;">HPD Online ↗</a>
      </div>
    </div>
  `;
}

// ─── FIND ABOUT SECTION ───────────────────────────────────────────────────
function findAboutSection() {
  // Explicit class fragments (most reliable)
  const explicit = document.querySelector([
    '[class*="AboutBuilding"]',
    '[class*="about-building"]',
    '[class*="BuildingInfo"]',
    '[class*="buildingInfo"]',
    '[class*="AboutBuildingSection"]',
    '[data-testid*="about-building"]',
    '[data-testid*="building-info"]',
  ].join(','));
  if (explicit) return explicit;

  // Walk sections looking for "About" heading
  for (const el of document.querySelectorAll('section, article, [class*="Section"]')) {
    const heading = el.querySelector('h1,h2,h3,h4,h5,h6');
    if (heading?.textContent.toLowerCase().includes('about')) return el;
  }

  return null;
}

// ─── INJECT DETAIL PANEL ─────────────────────────────────────────────────
function injectDetailPanel(crime, hpd, noise, dob, ageDays) {
  // Always nuke stale panel
  document.querySelector('.se-insights-panel')?.remove();

  const div = document.createElement('div');
  div.innerHTML = buildDetailPanel(crime, hpd, noise, dob, ageDays);
  const panel = div.firstElementChild;

  const anchor = findAboutSection();
  if (anchor) {
    anchor.after(panel);
    console.log('[SE Insights] Injected after:', anchor.className || anchor.tagName);
    return;
  }

  // Fallback: prepend to main
  const main = document.querySelector('main, [class*="mainContainer"], [class*="main"]');
  if (main) {
    main.prepend(panel);
    console.log('[SE Insights] Fallback: prepend to main');
  }
}

// ─── INJECT CARD BADGE ────────────────────────────────────────────────────
function injectCardBadge(card, crime, hpd) {
  card.querySelector('.se-card-badge')?.remove();
  const html = buildCardBadge(crime, hpd);
  if (!html) return;

  const div = document.createElement('div');
  div.innerHTML = html;
  const badge = div.firstElementChild;

  const priceEl = card.querySelector('[class*="price"],[class*="Price"],[class*="rent"]');
  const anchor  = priceEl?.closest('div') || card.querySelector('div');
  if (anchor) anchor.after(badge);
  else card.appendChild(badge);
}

// ─── PROCESSORS ───────────────────────────────────────────────────────────
async function processCard(card) {
  if (card.dataset.seProcessed) return;
  card.dataset.seProcessed = '1';

  const addrEl = card.querySelector([
    '[class*="addressText"]',
    '[class*="address"]',
    '[class*="Address"]',
  ].join(','));
  const address = addrEl?.textContent?.trim()?.replace(/#.*/, '').trim();
  if (!address) return;

  const coords = await geocodeAddress(address);
  const [crime, hpd] = await Promise.all([
    coords ? fetchCrime(coords.lat, coords.lon) : null,
    fetchHPD(address),
  ]);
  injectCardBadge(card, crime, hpd);
}

async function processDetailPage() {
  // Re-inject if panel was wiped from DOM
  const existing = document.querySelector('.se-insights-panel');
  if (existing && document.body.contains(existing)) return;

  const address = getDetailAddress();
  if (!address) { console.log('[SE Insights] No address found'); return; }
  console.log('[SE Insights] Processing detail page:', address);

  const coords = extractPageCoords() || await geocodeAddress(address);
  if (!coords) { console.log('[SE Insights] No coords for:', address); return; }

  const [crime, hpd, noise, dob, ageDays] = await Promise.all([
    fetchCrime(coords.lat, coords.lon),
    fetchHPD(address),
    fetchNoise(coords.lat, coords.lon),
    fetchDOB(address),
    Promise.resolve(getListingAgeDays()),
  ]);

  injectDetailPanel(crime, hpd, noise, dob, ageDays);
  console.log('[SE Insights] Detail panel complete');
}

// ─── OBSERVER ─────────────────────────────────────────────────────────────
let seDetailTimer = null;

const observer = new MutationObserver((mutations) => {
  // Detail page: debounce re-injection after React re-renders
  if (isDetailPage()) {
    clearTimeout(seDetailTimer);
    seDetailTimer = setTimeout(() => {
      const existing = document.querySelector('.se-insights-panel');
      if (!existing || !document.body.contains(existing)) {
        processDetailPage();
      }
    }, 1500);
  }

  // Cards: process new nodes as they appear
  for (const mut of mutations) {
    for (const node of mut.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.('[data-testid="listing-card"]')) processCard(node);
      else node.querySelectorAll?.('[data-testid="listing-card"]').forEach(processCard);
    }
  }
});

// ─── INIT ─────────────────────────────────────────────────────────────────
function init() {
  observer.observe(document.body, { childList: true, subtree: true });

  if (isDetailPage()) {
    setTimeout(processDetailPage, 2000);
  } else {
    document.querySelectorAll('[data-testid="listing-card"]').forEach((card, i) =>
      setTimeout(() => processCard(card), i * 200)
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  setTimeout(init, 1000);
}

})();
