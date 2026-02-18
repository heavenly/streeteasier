# StreetEasy Safety Overlay v2.2

Injects crime scores (NYPD), HPD violations, noise complaints, DOB issues under listing cards and detail pages.

## Install
```
1. Tampermonkey/Violentmonkey
2. Paste script → Save (Ctrl+S)
3. Reload StreetEasy
```

## Features
**Cards:** 🟢 LOW Danger | 12 arrests | HPD: 0v  
**Details:** Full panel under "About Building" w/ crime, HPD, 311 noise, DOB, listing age

## Config
```js
APP_TOKEN: '',           // NYC Open Data (optional)
WALKSCORE_KEY: '',       // Transit scores (optional)
CRIME_RADIUS_MILES: 0.25 // Adjust radius
```

## Data
- NYPD arrests (6mo, 0.25mi): F=10pts, M=3pts, V=1pt
- 🟢≤10 🟡≤30 🟠≤60 🔴>60 pts/mo
- HPD open violations + pest
- 311 noise complaints
- DOB active violations

## Debug
```
Console → [SE Insights] logs
Hard refresh (Ctrl+F5)
Wait 3s for SPA load
```

## Supported
- `/for-rent/*` `/for-sale/*` `/building/*` `/rental/*`
- SPA navigation & infinite scroll
- 24h localStorage cache
```

**12kb -  Client-side -  No tracking**