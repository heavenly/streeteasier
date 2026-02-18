// ==UserScript==
// @name         StreetEasy NYC Safety & Insights Overlay
// @namespace    https://streeteasy.com/
// @version      2.0.0
// @description  List cards: Danger level + HPD. Detail pages: Full insights (transit, schools, flood, noise, DOB, listing age, price comps)
// @author       heavenly
// @match        https://streeteasy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      geosearch.planninglabs.nyc
// @connect      data.cityofnewyork.us
// @connect      api.walkscore.com
// @connect      schools.nyc.gov
// @connect      data.cityofnewyork.us
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  const CONFIG = {
    APP_TOKEN: '',                        // NYC Open Data token (optional)
    WALKSCORE_KEY: '',                    // Optional Walk Score API key
    CRIME_RADIUS_MILES: 0.25,
    CACHE_TTL_MS: 24 * 60 * 60 * 1000,  // 24 hours
    ARREST_LOOKBACK_MONTHS: 6,
    CRIME_WEIGHTS: { F: 10, M: 3, V: 1 },
    DANGER_THRESHOLDS: [
      { max: 10,       label: 'Low',    emoji: '🟢', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
      { max: 30,       label: 'Medium', emoji: '🟡', color: '#ca8a04', bg: '#fefce8', border: '#fef08a' },
      { max: 60,       label: 'High',   emoji: '🟠', color: '#ea580c', bg: '#fff7ed', border: '#fed7aa' },
      { max: Infinity, label: 'Severe', emoji: '🔴', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
    ],
  };

  const NYPD_YTD_URL      = 'https://data.cityofnewyork.us/resource/uip8-fykc.json';
  const NYPD_HISTORIC_URL = 'https://data.cityofnewyork.us/resource/8h9b-rp9u.json';
  const HPD_COMPLAINT_URL = 'https://data.cityofnewyork.us/resource/uwyv-629c.json';
  const HPD_VIOLATION_URL = 'https://data.cityofnewyork.us/resource/wvxf-dwi5.json';
  const NYC_311_URL       = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json';
  const DOB_VIOLATIONS_URL= 'https://data.cityofnewyork.us/resource/h2n3-pwk2.json';

  // ─── UTILS ───────────────────────────────────────────────────────────────

  function lsKey(key) { return `se_insights_v2_${key}`; }

  function getCache(key) {
    try {
      const raw = localStorage.getItem(lsKey(key));
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > CONFIG.CACHE_TTL_MS) {
        localStorage.removeItem(lsKey(key));
        return null;
      }
      return data;
    } catch { return null; }
  }

  function setCache(key, data) {
    try {
      localStorage.setItem(lsKey(key), JSON.stringify({ ts: Date.now(), data }));
    } catch { /* storage full */ }
  }

  /** Wraps GM_xmlhttpRequest as a Promise. Always resolves (never rejects). */
  function gmFetch(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload(resp) {
          try {
            const parsed = JSON.parse(resp.responseText);
            if (parsed && parsed.message && !Array.isArray(parsed)) {
              console.warn('[SE Insights] API error:', parsed.message, 'for', url);
              resolve(null);
            } else {
              resolve(parsed);
            }
          } catch { resolve(null); }
        },
        onerror()  { resolve(null); },
        ontimeout(){ resolve(null); },
        timeout: 10000,
      });
    });
  }

  // ─── PAGE TYPE DETECTION ──────────────────────────────────────────────────

  function isListingCardPage() {
    return !!document.querySelector('[data-testid="listing-card"]');
  }

  function isDetailPage() {
    return window.location.pathname.match(/^\/building\/[^\/]+\/[^\/]+$/);
  }

  // ─── GEOCODING ───────────────────────────────────────────────────────────

  async function geocodeAddress(address) {
    const ck = `geo_${address}`;
    const cached = getCache(ck);
    if (cached) return cached;

    const url = `https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(address + ', New York, NY')}&size=1`;
    const data = await gmFetch(url);
    const feat = data?.features?.[0];
    if (!feat) return null;
    const [lon, lat] = feat.geometry.coordinates;
    const result = { lat, lon };
    setCache(ck, result);
    return result;
  }

  // Extract coords from StreetEasy's static map URL on detail pages
  function extractCoordsFromPage() {
    const mapImg = document.querySelector('img[src*="maps.googleapis.com"]');
    if (!mapImg) return null;
    
    const url = new URL(mapImg.src);
    const centerMatch = url.searchParams.get('center')?.match(/(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (centerMatch) {
      return {
        lat: parseFloat(centerMatch[1]),
        lon: parseFloat(centerMatch[2])
      };
    }
    return null;
  }

  // ─── EXISTING FUNCTIONS (Crime + HPD) ─────────────────────────────────────

  function milesToDeg(miles) { return miles / 69.0; }

  function buildArrestUrls(lat, lon) {
    const d = milesToDeg(CONFIG.CRIME_RADIUS_MILES);
    const now = new Date();
    const cutoff = new Date();
    cutoff.setMonth(now.getMonth() - CONFIG.ARREST_LOOKBACK_MONTHS);
    const cutoffStr = cutoff.toISOString().split('T')[0] + 'T00:00:00.000';

    const bboxWhere = `latitude > '${(lat - d).toFixed(6)}' AND latitude < '${(lat + d).toFixed(6)}' AND longitude > '${(lon - d).toFixed(6)}' AND longitude < '${(lon + d).toFixed(6)}'`;
    const dateWhere = `arrest_date >= '${cutoffStr}'`;
    const fullWhere = `${bboxWhere} AND ${dateWhere}`;

    const token = CONFIG.APP_TOKEN ? `&$$app_token=${CONFIG.APP_TOKEN}` : '';
    const select = '$select=law_cat_cd,ofns_desc,arrest_date&$limit=2000';

    const urls = [`${NYPD_YTD_URL}?$where=${encodeURIComponent(fullWhere)}&${select}${token}`];

    if (cutoff.getFullYear() < now.getFullYear()) {
      urls.push(`${NYPD_HISTORIC_URL}?$where=${encodeURIComponent(fullWhere)}&${select}${token}`);
    }

    return urls;
  }

  async function fetchArrestDanger(lat, lon) {
    const ck = `arrests_${lat.toFixed(4)}_${lon.toFixed(4)}`;
    const cached = getCache(ck);
    if (cached !== null) return cached;

    const urls = buildArrestUrls(lat, lon);
    const results = await Promise.all(urls.map(gmFetch));
    const allArrests = results.filter(r => Array.isArray(r)).flat();

    let score = 0;
    const breakdown = { F: 0, M: 0, V: 0, other: 0 };

    for (const a of allArrests) {
      const cat = (a.law_cat_cd || '').trim().toUpperCase();
      const weight = CONFIG.CRIME_WEIGHTS[cat] ?? 1;
      score += weight;
      if (cat in breakdown) breakdown[cat]++;
      else breakdown.other++;
    }

    const scorePerMonth = score / CONFIG.ARREST_LOOKBACK_MONTHS;
    const result = {
      score: scorePerMonth,
      breakdown,
      total: allArrests.length,
    };

    setCache(ck, result);
    return result;
  }

  function parseAddress(address) {
    const clean = address.replace(/\s*#.*$/, '').trim();
    const match = clean.match(/^(\d+[\w-]*)\s+(.+)$/);
    if (!match) return null;
    return {
      houseNum: match[1],
      street: match[2].trim().toUpperCase(),
    };
  }

  async function fetchHPDData(address) {
    const ck = `hpd_${address}`;
    const cached = getCache(ck);
    if (cached !== null) return cached;

    const parsed = parseAddress(address);
    if (!parsed) return { complaints: [], violations: [] };

    const { houseNum, street } = parsed;
    const streetFirstWord = street.split(' ')[0];
    const token = CONFIG.APP_TOKEN ? `&$$app_token=${CONFIG.APP_TOKEN}` : '';

    const complaintsWhere = encodeURIComponent(
      `housenumber='${houseNum}' AND streetname LIKE '${street}%'`
    );
    const violationsWhere = encodeURIComponent(
      `housenumber='${houseNum}' AND streetname LIKE '${street}%'`
    );

    const complaintURL = `${HPD_COMPLAINT_URL}?$where=${complaintsWhere}&$select=complaintid,apartment,statusdate,type,codedescription,status,majorcategoryid,minorcategoryid&$order=statusdate DESC&$limit=100${token}`;
    const violationURL = `${HPD_VIOLATION_URL}?$where=${violationsWhere}&$select=violationid,apartment,inspectiondate,class,novdescription,currentstatus&$order=inspectiondate DESC&$limit=100${token}`;

    const [complaintsRaw, violationsRaw] = await Promise.all([
      gmFetch(complaintURL),
      gmFetch(violationURL),
    ]);

    const complaints = Array.isArray(complaintsRaw) ? complaintsRaw : [];
    const violations = Array.isArray(violationsRaw) ? violationsRaw : [];

    const result = { complaints, violations };
    if (complaints.length > 0 || violations.length > 0) {
      setCache(ck, result);
    }
    return result;
  }

  // ─── NEW FEATURES FOR DETAIL PAGES ────────────────────────────────────────

  async function fetchTransitScore(lat, lon) {
    // Walk Score API (free tier works for basics)
    const ck = `transit_${lat.toFixed(4)}_${lon.toFixed(4)}`;
    const cached = getCache(ck);
    if (cached) return cached;

    if (!CONFIG.WALKSCORE_KEY) return null;

    const url = `http://api.walkscore.com/score?format=json&lat=${lat}&lon=${lon}&wsapikey=${CONFIG.WALKSCORE_KEY}&transit=1`;
    const data = await gmFetch(url);
    
    const result = data ? {
      walk: data.walkscore,
      transit: data.transit_score,
      bike: data.bike_score,
      description: data.description || '',
      nearest: data.transit_note || ''
    } : null;
    
    if (result) setCache(ck, result);
    return result;
  }

  async function fetchNoiseComplaints(lat, lon) {
    const d = milesToDeg(0.25);
    const where = encodeURIComponent(
      `latitude > '${(lat - d).toFixed(6)}' AND latitude < '${(lat + d).toFixed(6)}' AND longitude > '${(lon - d).toFixed(6)}' AND longitude < '${(lon + d).toFixed(6)}' AND created_date > '2025-01-01' AND complaint_type LIKE '%NOISE%'`
    );
    
    const url = `${NYC_311_URL}?$where=${where}&$select=unique_key,complaint_type,created_date&$limit=100${CONFIG.APP_TOKEN ? `&$$app_token=${CONFIG.APP_TOKEN}` : ''}`;
    const data = await gmFetch(url);
    return Array.isArray(data) ? data.length : 0;
  }

  async function fetchDOBViolations(address) {
    const parsed = parseAddress(address);
    if (!parsed) return 0;
    
    const { houseNum, street } = parsed;
    const where = encodeURIComponent(
      `housenumber='${houseNum}' AND street_name LIKE '${street.split(' ')[0]}%' AND status LIKE '%OPEN%'`
    );
    
    const url = `${DOB_VIOLATIONS_URL}?$where=${where}&$select=violationid,status&$limit=50${CONFIG.APP_TOKEN ? `&$$app_token=${CONFIG.APP_TOKEN}` : ''}`;
    const data = await gmFetch(url);
    return Array.isArray(data) ? data.length : 0;
  }

  function getListingAge() {
    // Look for listing age indicators
    const ageEl = document.querySelector('[class*="daysOnMarket"], [class*="listed"], [class*="on-market"]');
    if (ageEl) {
      const text = ageEl.textContent.toLowerCase();
      if (text.includes('day')) return parseInt(text) || 0;
      if (text.includes('week')) return parseInt(text) * 7 || 0;
      if (text.includes('month')) return parseInt(text) * 30 || 0;
    }
    return null;
  }

  function getNeighborhoodMedianRent() {
    // StreetEasy often shows neighborhood medians - extract if available
    const medianEl = document.querySelector('[class*="medianRent"], [class*="neighborhoodMedian"]');
    if (medianEl) {
      const match = medianEl.textContent.match(/\$(\d+(?:,\d{3})?)/);
      return match ? parseInt(match[1].replace(/,/g, '')) : null;
    }
    return null;
  }

  function getCurrentRent() {
    const rentEl = document.querySelector('[class*="rentPrice"], [class*="monthlyRent"], [data-testid*="price"]');
    if (rentEl) {
      const match = rentEl.textContent.match(/\$(\d+(?:,\d{3})+)/);
      return match ? parseInt(match[1].replace(/,/g, '')) : null;
    }
    return null;
  }

  // ─── SCORING ─────────────────────────────────────────────────────────────

  function getDangerLevel(scorePerMonth) {
    for (const t of CONFIG.DANGER_THRESHOLDS) {
      if (scorePerMonth <= t.max) return t;
    }
    return CONFIG.DANGER_THRESHOLDS[CONFIG.DANGER_THRESHOLDS.length - 1];
  }

  // ─── UI BUILDERS ─────────────────────────────────────────────────────────

  function buildDangerBadge(dangerData) {
    if (!dangerData) {
      return `<span style="color:#9ca3af;font-size:12px">⚠️ Crime data unavailable</span>`;
    }

    const danger = getDangerLevel(dangerData.score);
    const { breakdown, total, score } = dangerData;

    const felonyBadge   = breakdown.F > 0 ? `<span style="background:#dc2626;color:white;border-radius:4px;padding:1px 6px;font-size:10px;margin-right:3px">${breakdown.F}F</span>` : '';
    const misdBadge     = breakdown.M > 0 ? `<span style="background:#f97316;color:white;border-radius:4px;padding:1px 6px;font-size:10px;margin-right:3px">${breakdown.M}M</span>` : '';
    const violBadge     = breakdown.V > 0 ? `<span style="background:#6b7280;color:white;border-radius:4px;padding:1px 6px;font-size:10px;margin-right:3px">${breakdown.V}V</span>` : '';

    return `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="display:inline-flex;align-items:center;gap:5px;background:${danger.bg};border:1.5px solid ${danger.border};border-radius:6px;padding:3px 10px;font-weight:700;font-size:13px;color:${danger.color};">
          ${danger.emoji} ${danger.label} Danger
        </span>
        <span style="font-size:11px;color:#6b7280">
          ${score.toFixed(1)} pts/mo · ${total} arrests (${CONFIG.ARREST_LOOKBACK_MONTHS}mo)
        </span>
      </div>
      <div style="margin-top:5px">
        ${felonyBadge}${misdBadge}${violBadge}
        ${(breakdown.F === 0 && breakdown.M === 0 && breakdown.V === 0) ? '<span style="color:#22c55e;font-size:11px">✓ No arrests found in radius</span>' : ''}
      </div>
    `;
  }

  function buildHPDSection(hpdData) {
    const complaints = Array.isArray(hpdData?.complaints) ? hpdData.complaints : [];
    const violations = Array.isArray(hpdData?.violations) ? hpdData.violations : [];

    if (complaints.length === 0 && violations.length === 0) {
      return `<span style="color:#22c55e;font-size:11px">✓ No HPD records found</span>`;
    }

    const openViols = violations.filter(v => {
      const s = (v.currentstatus || '').toUpperCase();
      return s.includes('OPEN') || s.includes('NOT COMPLIED') || s.includes('UNABLE');
    });

    const classCounts = { A: 0, B: 0, C: 0 };
    for (const v of openViols) {
      const cls = (v.class || '').trim().toUpperCase();
      if (cls in classCounts) classCounts[cls]++;
    }

    const classStyle = {
      A: { bg: '#6b7280', label: 'A (Non-Haz)' },
      B: { bg: '#f97316', label: 'B (Hazardous)' },
      C: { bg: '#dc2626', label: 'C (Immediate!)' },
    };

    const violBadges = Object.entries(classCounts)
      .filter(([, n]) => n > 0)
      .map(([cls, n]) => `<span style="background:${classStyle[cls].bg};color:white;border-radius:4px;padding:1px 7px;font-size:10px;margin-right:4px;font-weight:600">${n} Class ${classStyle[cls].label}</span>`)
      .join('');

    const pestCount = complaints.filter(c =>
      JSON.stringify(c).toUpperCase().match(/ROACH|PEST|MICE|RAT|VERMIN|BED BUG/)
    ).length;

    const catCounts = {};
    for (const c of complaints) {
      const cat = c.type || c.majorcategoryid || c.codedescription || 'Other';
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
    const topCats = Object.entries(catCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k, v]) => `${k}(${v})`);

    let html = '';
    if (violBadges) html += `<div style="margin-bottom:4px">${violBadges}</div>`;
    if (openViols.length === 0 && violations.length > 0) {
      html += `<div style="color:#22c55e;font-size:11px;margin-bottom:3px">✓ No open violations (${violations.length} historical)</div>`;
    }
    if (pestCount > 0) {
      html += `<div style="color:#dc2626;font-size:11px;margin-bottom:3px">🪳 ${pestCount} pest complaints</div>`;
    }
    if (topCats.length > 0) {
      html += `<div style="color:#6b7280;font-size:10px">Top: ${topCats.join(' · ')}</div>`;
    }
    html += `<div style="color:#9ca3af;font-size:10px;margin-top:2px">${complaints.length} complaints · ${violations.length} violations</div>`;

    return html;
  }

  // NEW: Detail page insights panel
  function buildInsightsPanel(dangerData, hpdData, transitData, noiseCount, dobCount, listingAge, rentComparison) {
    const danger = dangerData ? getDangerLevel(dangerData.score) : CONFIG.DANGER_THRESHOLDS[0];

    const transitHtml = transitData ? `
      <div style="display:flex;align-items:center;gap:8px">
        🚇 <span style="font-weight:600">${transitData.transit}/100</span>
        <span style="font-size:11px;color:#6b7280">${transitData.nearest || transitData.description}</span>
      </div>
    ` : '<span style="color:#9ca3af;font-size:11px">Transit data unavailable</span>';

    const noiseHtml = noiseCount > 0 ? 
      `<span style="color:#f97316">🔊 ${noiseCount} noise complaints (6mo)</span>` : 
      '<span style="color:#22c55e">🔇 Low noise complaints</span>';

    const dobHtml = dobCount > 0 ? 
      `<span style="color:#dc2626">🏗️ ${dobCount} open DOB violations</span>` : 
      '<span style="color:#22c55e">✓ No open DOB violations</span>';

    const ageHtml = listingAge ? 
      (listingAge > 60 ? `<span style="color:#dc2626">📅 ${listingAge} days on market ⚠️</span>` :
       listingAge > 30 ? `<span style="color:#f97316">📅 ${listingAge} days on market</span>` :
       `<span style="color:#22c55e">📅 ${listingAge} days fresh</span>`) : '';

    const priceHtml = rentComparison ? 
      (rentComparison.isOverpriced ? 
        `<span style="color:#dc2626">💰 ${rentComparison.percentOverpriced}% above neighborhood median</span>` :
        `<span style="color:#22c55e">💰 Good value vs neighborhood</span>`) : '';

    return `
      <div class="se-insights-panel" style="
        margin: 16px 0;
        padding: 20px;
        background: ${danger.bg};
        border: 2px solid ${danger.border};
        border-radius: 12px;
        font-size: 14px;
        line-height: 1.6;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      ">
        <h3 style="margin:0 0 16px 0; font-size:18px; font-weight:700; color:${danger.color}; display:flex;align-items:center;gap:8px;">
          ${danger.emoji} ${danger.label} Area Safety & Insights
        </h3>

        <!-- Crime -->
        <div style="margin-bottom:16px">${buildDangerBadge(dangerData)}</div>

        <!-- HPD -->
        <div style="border-top:1px solid ${danger.border};padding-top:12px; margin-bottom:16px">
          <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:8px; text-transform:uppercase;letter-spacing:.5px">
            🏠 HPD Building Record
          </div>
          ${buildHPDSection(hpdData)}
        </div>

        <!-- Additional insights grid -->
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:12px; font-size:13px;">
          <div style="background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-weight:600; margin-bottom:4px;">Transit</div>
            ${transitHtml}
          </div>
          <div style="background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-weight:600; margin-bottom:4px;">Noise</div>
            ${noiseHtml}
          </div>
          <div style="background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-weight:600; margin-bottom:4px;">DOB</div>
            ${dobHtml}
          </div>
          ${ageHtml ? `<div style="background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-weight:600; margin-bottom:4px;">Listing Age</div>
            ${ageHtml}
          </div>` : ''}
          ${priceHtml ? `<div style="background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-weight:600; margin-bottom:4px;">Price Comp</div>
            ${priceHtml}
          </div>` : ''}
        </div>

        <div style="margin-top:16px; padding-top:12px; border-top:1px solid ${danger.border}; font-size:11px; color:#9ca3af; text-align:center">
          Data from NYPD, HPD, DOB, NYC 311 • Cached 24h • <a href="https://hpdonline.nyc.gov/hpdonline/" target="_blank" style="color:#0041D9">HPD Online</a> ↗
        </div>
      </div>
    `;
  }

  function buildCardOverlayHTML(dangerData, hpdData) {
    const danger = dangerData ? getDangerLevel(dangerData.score) : CONFIG.DANGER_THRESHOLDS[0];

    return `
      <div class="se-safety-overlay" style="
        margin: 8px 0 4px 0;
        padding: 10px 12px;
        background: ${danger.bg};
        border: 1px solid ${danger.border};
        border-radius: 8px;
        font-size: 13px;
        line-height: 1.5;
      ">
        ${buildDangerBadge(dangerData)}
        <div style="border-top:1px solid ${danger.border};padding-top:8px">
          <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:5px">
            🏠 HPD
          </div>
          ${buildHPDSection(hpdData)}
        </div>
      </div>
    `;
  }

  // ─── LISTING CARDS (existing functionality) ───────────────────────────────

  function extractAddressFromCard(card) {
    const el = card.querySelector('[class*="addressTextAction"], [class*="address"]');
    if (!el) return null;
    return el.textContent.trim().replace(/\s*#.*$/, '').trim();
  }

  async function processCard(card) {
    if (card.querySelector('.se-safety-overlay')) return;
    
    const address = extractAddressFromCard(card);
    if (!address) return;

    injectLoadingPlaceholder(card);

    try {
      const coords = await geocodeAddress(address);
      const [dangerData, hpdData] = await Promise.all([
        coords ? fetchArrestDanger(coords.lat, coords.lon) : Promise.resolve(null),
        fetchHPDData(address),
      ]);
      const wrapper = document.createElement('div');
      wrapper.innerHTML = buildCardOverlayHTML(dangerData, hpdData);
      const overlay = wrapper.firstElementChild;
      card.querySelector('[class*="priceInfoWrapper"]')?.parentElement?.after(overlay);
    } catch (err) {
      console.error('[SE Insights] Card error:', err);
    }
  }

  function injectLoadingPlaceholder(card) {
    if (card.querySelector('.se-safety-overlay')) return;
    const el = document.createElement('div');
    el.className = 'se-safety-overlay';
    el.style.cssText = 'margin:8px 0 4px 0;padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;font-size:12px;color:#9ca3af;';
    el.textContent = '⏳ Loading safety data…';
    card.querySelector('[class*="priceInfoWrapper"]')?.parentElement?.after(el);
  }

  // ─── DETAIL PAGE PROCESSING ───────────────────────────────────────────────

  async function processDetailPage() {
    if (document.querySelector('.se-insights-panel')) return;

    const addressEl = document.querySelector('p[class*="AboutBuildingSection_address"], [class*="address"]');
    const address = addressEl?.textContent.trim();
    if (!address) return;

    // Try page-embedded coords first, then geocode
    let coords = extractCoordsFromPage();
    if (!coords) coords = await geocodeAddress(address);

    injectDetailLoading();

    try {
      const [
        dangerData, 
        hpdData, 
        transitData, 
        noiseCount, 
        dobCount,
        listingAge,
        neighborhoodMedian
      ] = await Promise.all([
        coords ? fetchArrestDanger(coords.lat, coords.lon) : Promise.resolve(null),
        fetchHPDData(address),
        coords ? fetchTransitScore(coords.lat, coords.lon) : Promise.resolve(null),
        coords ? fetchNoiseComplaints(coords.lat, coords.lon) : Promise.resolve(0),
        fetchDOBViolations(address),
        Promise.resolve(getListingAge()),
        Promise.resolve(getNeighborhoodMedianRent())
      ]);

      const currentRent = getCurrentRent();
      const rentComparison = neighborhoodMedian && currentRent && currentRent > neighborhoodMedian * 1.1 ? {
        isOverpriced: true,
        percentOverpriced: Math.round((currentRent / neighborhoodMedian - 1) * 100)
      } : null;

      const html = buildInsightsPanel(dangerData, hpdData, transitData, noiseCount, dobCount, listingAge, rentComparison);
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      const panel = wrapper.firstElementChild;

      // Inject after hero carousel or price section
      const target = document.querySelector('[class*="HomeDetailsApp_mainContainer"], main') || 
                     document.querySelector('[data-testid="app-component"]');
      if (target) {
        target.insertBefore(panel, target.children[1] || target.firstChild);
      }
    } catch (err) {
      console.error('[SE Insights] Detail page error:', err);
    }
  }

  function injectDetailLoading() {
    if (document.querySelector('.se-insights-panel')) return;
    const el = document.createElement('div');
    el.className = 'se-insights-panel';
    el.style.cssText = `
      margin:16px 0; padding:20px; background:#f9fafb; border:2px solid #e5e7eb; 
      border-radius:12px; font-size:14px; text-align:center; color:#9ca3af;
    `;
    el.innerHTML = '⏳ Loading comprehensive safety & neighborhood insights…';
    
    const target = document.querySelector('[class*="HomeDetailsApp_mainContainer"], main');
    if (target) target.insertBefore(el, target.children[1]);
  }

  // ─── OBSERVERS ───────────────────────────────────────────────────────────

  function setupCardObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.('[data-testid="listing-card"]')) {
            setTimeout(() => processCard(node), 500);
          } else {
            node.querySelectorAll?.('[data-testid="listing-card"]').forEach(card => 
              setTimeout(() => processCard(card), 500)
            );
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function setupDetailObserver() {
    const observer = new MutationObserver(() => {
      if (isDetailPage()) {
        setTimeout(processDetailPage, 2000);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────

  function init() {
    if (isListingCardPage()) {
      const cards = document.querySelectorAll('[data-testid="listing-card"]');
      cards.forEach((card, i) => setTimeout(() => processCard(card), i * 300));
      setupCardObserver();
    }

    if (isDetailPage()) {
      setTimeout(processDetailPage, 2000);
      setupDetailObserver();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 1500);
  }

})();
