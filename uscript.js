// ==UserScript==
// @name         StreetEasy NYC Safety & Violations Overlay
// @namespace    https://streeteasy.com/
// @version      1.1.0
// @description  Adds danger level (NYPD arrests) + HPD complaints/violations to each listing card
// @author       heavenly
// @match        https://streeteasy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      geosearch.planninglabs.nyc
// @connect      data.cityofnewyork.us
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  const CONFIG = {
    APP_TOKEN: '',                        // NYC Open Data token (optional)
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

  // ─── CACHE (localStorage + TTL) ──────────────────────────────────────────

  function lsKey(key) { return `se_overlay_v2_${key}`; }

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

  // ─── NETWORK ─────────────────────────────────────────────────────────────

  /** Wraps GM_xmlhttpRequest as a Promise. Always resolves (never rejects). */
  function gmFetch(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload(resp) {
          try {
            const parsed = JSON.parse(resp.responseText);
            // Socrata returns { message, errorCode } on errors
            if (parsed && parsed.message && !Array.isArray(parsed)) {
              console.warn('[SE Overlay] API error:', parsed.message, 'for', url);
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

  // ─── NYPD ARRESTS ────────────────────────────────────────────────────────

  function milesToDeg(miles) { return miles / 69.0; }

  /**
   * Decides whether to query the YTD dataset, the Historic dataset, or both,
   * based on how many months of lookback are needed relative to today.
   * The YTD dataset resets every Jan 1, so in early months it may not have
   * a full 6-month window — we supplement with historic data in that case.
   */
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

    const urls = [];

    // Always include YTD
    urls.push(`${NYPD_YTD_URL}?$where=${encodeURIComponent(fullWhere)}&${select}${token}`);

    // If cutoff is in a previous year, also pull historic to fill the gap
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

    // Merge results from all datasets, deduplicate (no unique id so just concatenate)
    const allArrests = results
      .filter(r => Array.isArray(r))
      .flat();

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

  // ─── HPD DATA ─────────────────────────────────────────────────────────────

  /**
   * Parse "123 Main Street #4B" → { houseNum: "123", street: "MAIN STREET" }
   * Handles addresses like "160 Riverside Boulevard", "40 Bruckner Boulevard"
   */
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

    // Use exact match on housenumber and first word of street for reliability
    // Full street name match is more precise but can fail on abbreviations
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

    // *** THE KEY FIX: always fall back to [] if response is not an array ***
    const complaints = Array.isArray(complaintsRaw) ? complaintsRaw : [];
    const violations = Array.isArray(violationsRaw) ? violationsRaw : [];

    const result = { complaints, violations };
    // Only cache if we got some data (don't cache empty API errors)
    if (complaints.length > 0 || violations.length > 0) {
      setCache(ck, result);
    }
    return result;
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

    // Color-coded inline badges for each crime category
    const felonyBadge   = breakdown.F > 0
      ? `<span style="background:#dc2626;color:white;border-radius:4px;padding:1px 6px;font-size:10px;margin-right:3px">${breakdown.F}F</span>` : '';
    const misdBadge     = breakdown.M > 0
      ? `<span style="background:#f97316;color:white;border-radius:4px;padding:1px 6px;font-size:10px;margin-right:3px">${breakdown.M}M</span>` : '';
    const violBadge     = breakdown.V > 0
      ? `<span style="background:#6b7280;color:white;border-radius:4px;padding:1px 6px;font-size:10px;margin-right:3px">${breakdown.V}V</span>` : '';

    return `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="
          display:inline-flex;align-items:center;gap:5px;
          background:${danger.bg};
          border:1.5px solid ${danger.border};
          border-radius:6px;
          padding:3px 10px;
          font-weight:700;
          font-size:13px;
          color:${danger.color};
        ">
          ${danger.emoji} ${danger.label} Danger
        </span>
        <span style="font-size:11px;color:#6b7280">
          ${score.toFixed(1)} pts/mo · ${total} arrests (${CONFIG.ARREST_LOOKBACK_MONTHS}mo)
        </span>
      </div>
      <div style="margin-top:5px">
        ${felonyBadge}${misdBadge}${violBadge}
        ${(breakdown.F === 0 && breakdown.M === 0 && breakdown.V === 0)
          ? '<span style="color:#22c55e;font-size:11px">✓ No arrests found in radius</span>'
          : ''}
      </div>
    `;
  }

  function buildHPDSection(hpdData) {
    // *** Safe guard: always destructure with defaults ***
    const complaints = Array.isArray(hpdData?.complaints) ? hpdData.complaints : [];
    const violations = Array.isArray(hpdData?.violations) ? hpdData.violations : [];

    if (complaints.length === 0 && violations.length === 0) {
      return `<span style="color:#22c55e;font-size:11px">✓ No HPD records found for this address</span>`;
    }

    // Open violations by class (A/B/C)
    const openViols = violations.filter(v => {
      const s = (v.currentstatus || '').toUpperCase();
      return s.includes('OPEN') || s.includes('NOT COMPLIED') || s.includes('UNABLE');
    });

    const classCounts = { A: 0, B: 0, C: 0 };
    for (const v of openViols) {
      const cls = (v.class || v.novclass || '').trim().toUpperCase();
      if (cls in classCounts) classCounts[cls]++;
    }

    const classStyle = {
      A: { bg: '#6b7280', label: 'A (Non-Haz)' },
      B: { bg: '#f97316', label: 'B (Hazardous)' },
      C: { bg: '#dc2626', label: 'C (Immediate!)' },
    };

    const violBadges = Object.entries(classCounts)
      .filter(([, n]) => n > 0)
      .map(([cls, n]) =>
        `<span style="background:${classStyle[cls].bg};color:white;border-radius:4px;padding:1px 7px;font-size:10px;margin-right:4px;font-weight:600">${n} Class ${classStyle[cls].label}</span>`
      ).join('');

    // Pest/roach complaints
    const pestCount = complaints.filter(c =>
      JSON.stringify(c).toUpperCase().match(/ROACH|PEST|MICE|MOUSE|RAT\b|VERMIN|INFESTATION|BED BUG/)
    ).length;

    // Top complaint categories
    const catCounts = {};
    for (const c of complaints) {
      const cat = c.type || c.majorcategoryid || c.codedescription || 'Other';
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
    const topCats = Object.entries(catCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}&nbsp;(${v})`);

    let html = '';

    if (violBadges) {
      html += `<div style="margin-bottom:4px">${violBadges}</div>`;
    }

    if (openViols.length === 0 && violations.length > 0) {
      html += `<div style="color:#22c55e;font-size:11px;margin-bottom:3px">✓ No open violations (${violations.length} historical)</div>`;
    }

    if (pestCount > 0) {
      html += `<div style="color:#dc2626;font-size:11px;margin-bottom:3px">🪳 ${pestCount} pest/roach complaint${pestCount !== 1 ? 's' : ''} on record</div>`;
    }

    if (topCats.length > 0) {
      html += `<div style="color:#6b7280;font-size:10px">Top complaints: ${topCats.join(' · ')}</div>`;
    }

    html += `<div style="color:#9ca3af;font-size:10px;margin-top:2px">${complaints.length} complaint${complaints.length !== 1 ? 's' : ''} · ${violations.length} violation${violations.length !== 1 ? 's' : ''} on record</div>`;

    return html;
  }

  // ─── INJECTION ───────────────────────────────────────────────────────────

  function buildOverlayHTML(dangerData, hpdData, address) {
    const danger = dangerData ? getDangerLevel(dangerData.score) : CONFIG.DANGER_THRESHOLDS[0];
    const hpdLink = `https://hpdonline.nyc.gov/hpdonline/`;

    return `
      <div class="se-safety-overlay" style="
        margin: 8px 0 4px 0;
        padding: 10px 12px;
        background: ${danger.bg};
        border: 1px solid ${danger.border};
        border-radius: 8px;
        font-size: 13px;
        line-height: 1.5;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      ">
        <!-- Crime section -->
        <div style="margin-bottom:8px">
          ${buildDangerBadge(dangerData)}
        </div>

        <!-- HPD section -->
        <div style="border-top:1px solid ${danger.border};padding-top:8px">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
            <span style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.4px">🏠 HPD Building Record</span>
            <a href="${hpdLink}" target="_blank" rel="noopener"
               style="font-size:10px;color:#0041D9;text-decoration:none;border:1px solid #0041D9;border-radius:3px;padding:0 4px">
              View ↗
            </a>
          </div>
          ${buildHPDSection(hpdData)}
        </div>
      </div>
    `;
  }

  function injectOverlay(card, dangerData, hpdData, address) {
    // Remove any existing overlay (loading placeholder or stale data)
    card.querySelector('.se-safety-overlay')?.remove();

    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildOverlayHTML(dangerData, hpdData, address);
    const overlay = wrapper.firstElementChild;

    // Insert after the price info section, right below "base rent"
    const priceSection =
      card.querySelector('[class*="priceInfoWrapper"]')?.closest('[class*="marginBottom"]') ||
      card.querySelector('[class*="priceInfoWrapper"]')?.parentElement ||
      card.querySelector('[class*="PriceInfo"]')?.parentElement;

    if (priceSection) {
      priceSection.after(overlay);
    } else {
      card.querySelector('[class*="listingDetailsDiv"]')?.appendChild(overlay);
    }
  }

  function injectLoadingPlaceholder(card) {
    if (card.querySelector('.se-safety-overlay')) return;
    const el = document.createElement('div');
    el.className = 'se-safety-overlay';
    el.style.cssText = `
      margin:8px 0 4px 0;padding:8px 12px;
      background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;
      font-size:12px;color:#9ca3af;font-family:-apple-system,sans-serif;
    `;
    el.textContent = '⏳ Loading safety data…';

    const priceSection =
      card.querySelector('[class*="priceInfoWrapper"]')?.closest('[class*="marginBottom"]') ||
      card.querySelector('[class*="priceInfoWrapper"]')?.parentElement;

    priceSection?.after(el);
  }

  // ─── CORE PROCESSING ─────────────────────────────────────────────────────

  function extractAddress(card) {
    const el = card.querySelector('[class*="addressTextAction"]');
    if (!el) return null;
    return el.textContent.trim().replace(/\s*#.*$/, '').trim();
  }

  // Track in-progress cards to avoid duplicate fetches
  const processing = new WeakSet();

  async function processCard(card) {
    if (processing.has(card)) return;
    if (card.querySelector('.se-safety-overlay')) return;

    const address = extractAddress(card);
    if (!address) return;

    processing.add(card);
    injectLoadingPlaceholder(card);

    try {
      const coords = await geocodeAddress(address);
      const [dangerData, hpdData] = await Promise.all([
        coords ? fetchArrestDanger(coords.lat, coords.lon) : Promise.resolve(null),
        fetchHPDData(address),
      ]);
      injectOverlay(card, dangerData, hpdData, address);
    } catch (err) {
      console.error('[SE Overlay] Error processing card:', address, err);
      card.querySelector('.se-safety-overlay')?.remove();
      // Inject a fallback error state
      const el = document.createElement('div');
      el.className = 'se-safety-overlay';
      el.style.cssText = 'margin:8px 0 4px 0;padding:6px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:11px;color:#dc2626;';
      el.textContent = '⚠️ Safety data failed to load';
      const priceSection = card.querySelector('[class*="priceInfoWrapper"]')?.parentElement;
      priceSection?.after(el);
    }
    // Note: keep in WeakSet so we don't re-process on MutationObserver re-fires
  }

  function processAllCards() {
    const cards = document.querySelectorAll('[data-testid="listing-card"]');
    cards.forEach((card, i) => setTimeout(() => processCard(card), i * 250));
  }

  // ─── MUTATION OBSERVER (SPA navigation + dynamic card loads) ─────────────

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('[data-testid="listing-card"]')) {
          processCard(node);
        } else {
          node.querySelectorAll?.('[data-testid="listing-card"]').forEach(processCard);
        }
      }
    }
  });

  // ─── INIT ─────────────────────────────────────────────────────────────────

  function init() {
    processAllCards();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 1500);
  }

})();
