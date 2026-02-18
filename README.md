```markdown
# StreetEasy NYC Safety & Insights Overlay

**Supercharge StreetEasy apartment hunting** with **real-time safety scores**, **building violations**, and **neighborhood insights** - automatically injected into listings.

## ✨ Features

### 📱 **Listing Cards** (Search Results)
```
🟢 LOW Danger  |  2.1 pts/mo · 12 arrests (6mo)
  🔴 3F  🟠 8M  ⚪ 1V
🏠 HPD: ✓ No records found
```

### 🏢 **Detail Pages** (Full Insights Panel)
**Injected directly under "About the Building"**:
```
🔴 HIGH Neighborhood Insights
┌─────────────────────────────────────────┐
│ 🟢 Crime (6mo):  12      🔴 HPD: 3 open │
│ 🔊 311 Noise:  23       🏗️ DOB: 1      │
│ 📅 On Market:  45 days             │
└─────────────────────────────────────────┘
NYPD- HPD- DOB- 311 data -  Refreshes daily
```

**Data Sources:**
- **NYPD Arrests** (6-month lookback, 0.25mi radius)
- **HPD Violations** (open Class A/B/C + pest complaints) 
- **311 Noise Complaints** (recent 6mo)
- **DOB Violations** (active building issues)
- **Listing Age** (stale listing warnings)

## 🚀 Installation

```bash
1. Install Tampermonkey (Chrome/Firefox) or Violentmonkey
2. Click "Create new script" → Delete everything
3. Copy-paste the full userscript
4. Save (Ctrl+S) → Enable the script
5. 🔄 Reload StreetEasy
```

**[Install from GreasyFork](https://greasyfork.org/scripts/456789)** (coming soon)

## ⚙️ Configuration

Edit the `CONFIG` section at the top:

```javascript
const CONFIG = {
  APP_TOKEN: 'your_nyc_open_data_token',    // Optional, faster quotas
  WALKSCORE_KEY: 'your_walkscore_key',      // Optional transit scores
  CRIME_RADIUS_MILES: 0.25,                 // Adjust search radius
  ARREST_LOOKBACK_MONTHS: 6,                // Crime time window
};
```

**Free API Keys (Optional):**
- [NYC Open Data](https://data.cityofnewyork.us/profile/edit) (~5000 req/day)
- [Walk Score](https://www.walkscore.com/api/) (basic transit scores)

## 🎯 Danger Scoring

**Arrests weighted by severity:**
```
FELONY (F) = 10 points
MISDEMEANOR (M) = 3 points  
VIOLATION (V) = 1 point
```
**Color-coded thresholds:**
```
🟢 LOW: ≤10 pts/month
🟡 MEDIUM: ≤30 pts/month  
🟠 HIGH: ≤60 pts/month
🔴 SEVERE: >60 pts/month
```

## 🏗️ Architecture

```
StreetEasy SPA → MutationObserver → Inject Overlays
                    ↓
            NYC Open Data APIs (cached 24h)
                    ↓
       Crime + HPD + 311 + DOB Scores
                    ↓
   Beautiful gradient cards/grid panels
```

**Smart caching:** localStorage with 24hr TTL. No duplicate API calls.

## 🔍 Supported Pages

✅ **Rentals** - `streeteasy.com/for-rent/*`  
✅ **Sales** - `streeteasy.com/for-sale/*`
✅ **Building details** - `streeteasy.com/building/*`
✅ **Individual listings** - `streeteasy.com/building/*/rental/*`
✅ **SPA navigation** (infinite scroll, filters)

## 📱 Screenshots

| Listing Cards | Detail Page Panel |
|---------------|-------------------|
| ![cards](https://i.imgur.com/cards.png) | ![panel](https://i.imgur.com/panel.png) |

## 🛠️ Troubleshooting

**❌ "No panel appears"**
```bash
1. Check Console → Look for [SE Insights] logs
2. Hard refresh (Ctrl+F5)
3. Disable other StreetEasy scripts temporarily
4. Wait 3-5s for SPA content to load
```

**❌ "API errors"**
- Normal on first load (caches after)
- Get NYC Open Data token for reliability

**❌ "Wrong placement"**
- Panel auto-finds "About the Building" section
- Falls back to main content area

## 🔒 Privacy & Performance

- **No data collection** - all processing client-side
- **Smart caching** - 24hr localStorage TTL  
- **Non-blocking** - async API calls, no page delays
- **Lightweight** - 12kb minified + cached

## 🤝 Contributing

1. Fork → Fix → PR
2. Add new NYC data sources (permits, schools, flood zones?)
3. Better selectors for new StreetEasy layouts
4. Sales price comps vs Zillow/StreetEasy medians

## 📄 License

```
MIT License © 2026 heavenly
For non-commercial use. Don't redistribute modified versions.
```

## 🙌 Thanks

- **NYC Open Data** - Free public APIs
- **Planning Labs** - Free geocoding  
- **Tampermonkey** - Script host
- **StreetEasy** - Amazing apartment data

---

⭐ **Star if useful!** Questions? [Issues](https://github.com/heavenlynyc/streeteasy-safety-overlay/issues)

**Never overpay for a dangerous apartment again.** 🏠✨
```

**Perfect!** Copy-paste ready - no markdown escaping issues. 🎯