# SimBrief Flight Briefing

A visual flight briefing built from your latest SimBrief OFP, organised by phase
of flight rather than by document section — so each chapter carries only what is
useful at that point in the flight.

Hebrew (RTL) interface with a full English toggle. Aviation payloads — METAR,
TAF, NOTAM text, waypoint and runway identifiers — are never translated and stay
left-to-right in both languages.

Sized for an 11" iPad: 1194×834 landscape is the primary target, with a portrait
layout that moves the chapter rail to the bottom.

## Chapters

| # | Chapter | What it carries |
|---|---------|-----------------|
| 1 | Departure airport | Field data, transition altitude, decoded METAR/TAF, ATIS, NOTAMs, loading and weight margins, fuel breakdown, OUT/OFF/ON/IN |
| 2 | Takeoff | Planned-runway performance, V-speeds, head/crosswind components, a to-scale runway strip showing reject distance and remaining margin, configuration, SID |
| 3 | Cruise | The route weather strip, step-climb ladder, SimBrief charts, fuel margin curve, what-if impacts, FIRs |
| 4 | Descent | Top of descent, STAR, destination weather, landing fuel margin and holding time, terrain |
| 5 | Arrival airport | Landing performance, weather, NOTAMs, and the alternate in full |
| 6 | Summary | Every finding by severity, the flight numbers, the tightest margin, key NOTAMs |

Two placements are deliberate: the **destination weather sits in Descent**, because
that is where the diversion decision is actually made, and the **alternate card
stays expanded** rather than collapsed, because by the time it matters the crew is
already busy.

## The exception engine

`js/analyze.js` walks the OFP and flags what a linear read of the document tends to
hide. Findings appear at the top of their chapter, as a badge on the rail, and all
together in the summary.

| Check | Source | Threshold |
|---|---|---|
| Wind shear at a fix | `navlog.fix.shear` | ≥ 4 |
| ISA deviation | `oat_isa_dev` | \|dev\| ≥ 10 °C |
| Sharp wind-component change | delta between adjacent fixes | ≥ 30 kt |
| High terrain | `mora` | ≥ 10 000 ft |
| Fuel margin enroute | `fuel_plan_onboard − fuel_min_onboard` | < 500 kg |
| Landing fuel | vs reserve + alternate | < 15 min holding |
| ZFW / TOW / LDW margin | `weights` | < 500 kg |
| Crosswind | `crosswind_component` | ≥ 20 kt takeoff, ≥ 25 kt landing, ≥ 33 kt critical |
| Tailwind | negative `headwind_component` | ≥ 10 kt |
| Stop margin | `distance_margin` | < 300 ft |
| Blocking NOTAM | decoded Q-code subject + status | closure or unserviceability |
| Below-VFR conditions | `metar_category` | MVFR and worse |

Thresholds live in one table (`THRESHOLDS`) so they are easy to review. Crosswind
figures are the common 737-800 numbers — adjust there if your operating limits differ.

Runway matching respects the suffix letter: at a field with 06L/24R and 06R/24L, a
NOTAM closing 24R is reported as *another runway closed*, not as a critical alarm on
a 24L departure. A designator with no suffix is treated as covering the pair.

NOTAM closures are often bound to a daily window. The schedule is displayed rather
than parsed, so the crew judges the overlap — guessing at arbitrary schedule syntax
would be worse than showing it.

## Running locally

```bash
node tools/serve.js 3100
```

Serves the static site and routes `/api/*` through the same handlers Vercel runs, so
local behaviour matches deployed. Open <http://localhost:3100> and either enter a
SimBrief username or press **Show demo flight** to load the bundled fixture.

## Data

Everything comes from the SimBrief OFP — there are no external weather or NOTAM
calls. `api/ofp.js` proxies `simbrief.com/api/xml.fetcher.php` because the browser
cannot reach it directly (no CORS headers), and caches for 60 s.

A numeric input is sent as `userid`, anything else as `username`.

### The two sources disagree about "empty"

The live JSON API returns absent fields as an **empty object** `{}`; the XML export
writes an empty element, which converts to `""`. A typical OFP carries around 117 of
them. `isBlank()` in `js/normalize.js` is the single place that knows what absent
looks like — `str`, `num`, `flag` and `arr` all defer to it. Never call
`String(value)` on an OFP field directly: it renders `[object Object]`, and
`Boolean(...)` of that is `true`, which silently flips flags on.

The live API also returns single-item nodes as objects where the XML forces arrays
(one ATIS, one alternate). `arr()` normalises both.

Set `SIMBRIEF_USERNAME` as an environment variable to provide a default; otherwise
the username is entered in the app and stored in `localStorage` on the device.

## Tests

```bash
node test/engines.test.js
```

Runs the decoders and the exception engine against `test/fixture.json` — a real
ELY2569 LEBL→LCLK plan — so the expectations are facts about that flight rather
than invented numbers. Includes a pass with optional OFP sections stripped, to
confirm missing data renders as `—` instead of crashing.

Regenerate the fixture from an OFP XML with:

```bash
node tools/xml2json.js path/to/ofp.xml test/fixture.json
```
