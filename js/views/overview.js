/**
 * Chapter 0 — Overview.
 *
 * Laid out the way an airline EFB briefing opens: named sections (Schedule,
 * Route, Airports) with the title above the panel rather than inside a card
 * header, and a schedule band that draws the flight as a climb/cruise/descent
 * profile with the milestone times sitting on it.
 *
 * It stays out of the masonry grid on purpose -- this page is a fixed
 * composition read top to bottom, not a wall of independent cards.
 */

import { t } from '../i18n.js';
import {
  escapeHtml,
  fmtNumber,
  fmtDuration,
  fmtZulu,
  parseMetar,
  describeWind,
  categoryClass
} from '../decode.js';
import { icon, categoryDot, section } from '../ui.js';
import { dominantCruiseAltitude } from './cruise.js';
import { SEVERITY } from '../analyze.js';

export default function renderOverview({ model, findings }) {
  const critical = findings.filter((f) => f.severity === SEVERITY.CRITICAL).length;

  const watch = findings.length
    ? `<span class="sect-flag ${critical ? 'bad' : 'warn'}">
         ${icon('obstacle', { size: 14 })}${findings.length} ${escapeHtml(t('sum.watchItems'))}
       </span>`
    : `<span class="sect-flag good">${icon('info', { size: 14 })}${escapeHtml(t('sum.clean'))}</span>`;

  return `
    <div class="cover">
      ${section(t('ov.schedule'), 'clock', scheduleBand(model), { action: watch })}
      ${section(t('common.route'), 'routeSwap', routeBody(model))}
      ${section(t('ov.airports'), 'headset', airportsBody(model))}
    </div>
  `;
}

/* ------------------------------------------------------------- schedule */

/*
 * Curve geometry, in viewBox units. The shape is schematic -- it says
 * "ground, climb, cruise, descend, ground", not "this is the vertical
 * profile" -- so it stretches with the panel rather than preserving ratio.
 */
const VB_W = 900;
const VB_H = 150;
const GROUND_Y = 112;
const CRUISE_Y = 30;
const CLIMB_START = 235;
const DESCENT_END = 705;
const MARK_STEP = 68;

const pct = (value, total) => `${((value / total) * 100).toFixed(2)}%`;

/**
 * The schedule band: both airports, the profile curve, and the times a crew
 * is held to. Out-blocks/off/on/in are what the plan is measured against, so
 * they sit on the curve at the point of the flight they belong to rather than
 * in a table somewhere below.
 */
function scheduleBand(model) {
  const times = model.times;
  const cruiseAlt = dominantCruiseAltitude(model) || model.flight.initialAltitude;
  const units = model.units === 'lbs' ? 'lb' : 'kg';

  // Ground milestones, ordered outward from the takeoff/landing moment.
  const before = [
    { key: 'std', time: times.schedOut },
    { key: 'etd', time: times.estOut },
    { key: 'etot', time: times.estOff }
  ].filter((m) => m.time);

  const after = [
    { key: 'eta', time: times.estOn },
    { key: 'sta', time: times.estIn || times.schedIn }
  ].filter((m) => m.time);

  before.forEach((m, i) => {
    m.x = CLIMB_START - (before.length - 1 - i) * MARK_STEP;
  });
  after.forEach((m, i) => {
    m.x = DESCENT_END + i * MARK_STEP;
  });

  const marks = [...before, ...after];

  // Position rides a custom property rather than `left` directly, so the
  // narrow-screen rule can drop the markers into an evenly spaced row by
  // switching to static positioning -- five labels pinned to curve positions
  // collide on a phone. Physical, not logical: the curve runs departure to
  // arrival left-to-right in every language (its containers force LTR), so a
  // logical inset would mirror a marker away from its own dot in RTL.
  const dots = marks
    .map((m) => `<span class="sched-dot" style="--x:${pct(m.x, VB_W)};--y:${pct(GROUND_Y, VB_H)}"></span>`)
    .join('');

  const labels = marks
    .map(
      (m) => `<span class="sched-mark" style="--x:${pct(m.x, VB_W)}">
        <i>${escapeHtml(t(`ov.${m.key}`))}</i>
        <b class="ltr">${escapeHtml(fmtZulu(m.time))}</b>
      </span>`
    )
    .join('');

  const path =
    `M0,${GROUND_Y} L${CLIMB_START},${GROUND_Y} ` +
    `C${CLIMB_START + 55},${GROUND_Y} ${CLIMB_START + 65},${CRUISE_Y} ${CLIMB_START + 105},${CRUISE_Y} ` +
    `L${DESCENT_END - 105},${CRUISE_Y} ` +
    `C${DESCENT_END - 65},${CRUISE_Y} ${DESCENT_END - 55},${GROUND_Y} ${DESCENT_END},${GROUND_Y} ` +
    `L${VB_W},${GROUND_Y}`;

  const fact = (label, value) =>
    `<div><span>${escapeHtml(label)}</span><b class="ltr">${value}</b></div>`;

  return `<div class="sched">
    <div class="sched-top">
      ${port(model.origin, 'start')}
      <span class="sched-callsign ltr">${escapeHtml(model.flight.callsign || model.flight.number || '')}</span>
      ${port(model.destination, 'end')}
    </div>

    <div class="sched-graph">
      <svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="sched-curve" d="${path}"/>
      </svg>
      <span class="sched-duration ltr">${fmtDuration(times.estTimeEnroute ?? times.estBlock)}</span>
      <div class="sched-facts">
        ${fact(t('sum.blockFuel'), `${fmtNumber(model.fuel.planRamp)} ${units}`)}
        ${fact(t('ov.groundDistance'), `${fmtNumber(model.route.distance)} nm`)}
        ${fact(t('dep.cruiseAlt'), cruiseAlt ? `FL${Math.round(cruiseAlt / 100)}` : '—')}
      </div>
      ${dots}
    </div>

    <div class="sched-marks">${labels}</div>
  </div>`;
}

function port(airport, side) {
  if (!airport) return '<span></span>';
  const iata = airport.iata ? `${airport.iata} - ` : '';
  return `<div class="sched-port ${side}">
    <b class="ltr">${escapeHtml(airport.icao || '—')}</b>
    <span>${escapeHtml(`${iata}${airport.name || ''}`)}</span>
  </div>`;
}

/* ----------------------------------------------------------------- route */

function routeBody(model) {
  const map = mapBlock(model);
  const text = model.route.text || model.route.flightplanText;

  return `
    ${map}
    ${
      text
        ? `<div class="sect-field">
             <span class="k">${escapeHtml(t('dep.atcPlan'))}</span>
             <div class="raw-wx">${escapeHtml(text)}</div>
           </div>`
        : ''
    }
    <div class="sect-fields">
      ${field(t('to.sid'), model.route.sid)}
      ${field(t('des.star'), model.route.star)}
      ${field(t('sum.airDistance'), model.route.airDistance ? `${fmtNumber(model.route.airDistance)} nm` : null)}
      ${field(t('crz.firs'), model.route.firs.join(' · '))}
    </div>
  `;
}

function field(label, value) {
  return `<div class="sect-field">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v ltr">${value ? escapeHtml(value) : '—'}</span>
  </div>`;
}

function mapBlock(model) {
  const track = trackSvg(model);
  const chart = model.images.route;
  if (!track && !chart) return '';

  if (!chart) return `<div class="cover-map">${track}</div>`;
  if (!track) return `<div class="cover-map">${chartPane(chart, false)}</div>`;

  return `<div class="cover-map" data-map-group>
    <div class="cover-map-tabs">
      <button class="chart-tab" data-action="map-mode" data-mode="track" aria-selected="true">${escapeHtml(t('ov.mapTrack'))}</button>
      <button class="chart-tab" data-action="map-mode" data-mode="chart" aria-selected="false">${escapeHtml(t('ov.mapChart'))}</button>
    </div>
    <div data-map-pane="track">${track}</div>
    <div data-map-pane="chart" hidden>${chartPane(chart, true)}</div>
  </div>`;
}

/**
 * SimBrief's own route map. It is a light-background image, so it is inverted
 * to sit in a dark cockpit theme -- hue-rotate puts the colours back after the
 * inversion flips them.
 *
 * SimBrief expires these generated files, so an older OFP can point at a map
 * that no longer exists. Rather than leave an empty frame, the pane says so
 * and the planned track is still one tap away.
 */
function chartPane(src, padded) {
  return `<div class="cover-chart${padded ? ' padded' : ''}">
    <img src="${escapeHtml(src)}" alt="${escapeHtml(t('crz.routeMap'))}" loading="lazy"
         onerror="this.closest('.cover-chart').dataset.failed='1'">
    <div class="cover-chart-fallback">${escapeHtml(t('ov.mapUnavailable'))}</div>
  </div>`;
}

/**
 * The planned track drawn from the OFP's own coordinates.
 *
 * Equirectangular, with longitude squeezed by cos(mid latitude) so the shape
 * stays close to true at the scale of one flight. There is no coastline data
 * in an OFP, so a lat/lon graticule carries the spatial context instead.
 */
function trackSvg(model) {
  const legs = [];
  const add = (lat, lon, ident) => {
    if (Number.isFinite(lat) && Number.isFinite(lon)) legs.push({ lat, lon, ident });
  };

  add(model.origin?.lat, model.origin?.lon, model.origin?.icao);
  model.navlog.forEach((f) => add(f.lat, f.lon, f.ident));
  add(model.destination?.lat, model.destination?.lon, model.destination?.icao);
  if (legs.length < 2) return null;

  const altn = model.alternates[0];
  const altnPoint =
    altn && Number.isFinite(altn.lat) && Number.isFinite(altn.lon)
      ? { lat: altn.lat, lon: altn.lon, ident: altn.icao }
      : null;

  const all = altnPoint ? [...legs, altnPoint] : legs;

  const W = 900;
  const pad = 38;

  const midLat = (Math.min(...all.map((p) => p.lat)) + Math.max(...all.map((p) => p.lat))) / 2;
  const squeeze = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const rawX = (p) => p.lon * squeeze;
  const rawY = (p) => -p.lat;

  const xs = all.map(rawX);
  const ys = all.map(rawY);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 0.01);
  const spanY = Math.max(maxY - minY, 0.01);

  // Height follows the route's own shape so a wide, shallow crossing doesn't
  // sit in a tall frame of empty space. Clamped so a near-north/south route
  // can't produce an absurdly tall panel either.
  const H = Math.round(Math.min(460, Math.max(190, (W - pad * 2) * (spanY / spanX) + pad * 2)));

  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;

  const X = (p) => offX + (rawX(p) - minX) * scale;
  const Y = (p) => offY + (rawY(p) - minY) * scale;

  const track = legs.map((p, i) => `${i ? 'L' : 'M'}${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(' ');

  const dots = legs
    .slice(1, -1)
    .map((p) => `<circle class="ov-fix" cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="2.2"/>`)
    .join('');

  const first = legs[0];
  const last = legs[legs.length - 1];

  const endpoint = (p, label) => `
    <circle class="ov-port" cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="6"/>
    <text class="ov-label" x="${X(p).toFixed(1)}" y="${(Y(p) - 14).toFixed(1)}" text-anchor="middle">${escapeHtml(label)}</text>`;

  const alternate = altnPoint
    ? `<circle class="ov-altn" cx="${X(altnPoint).toFixed(1)}" cy="${Y(altnPoint).toFixed(1)}" r="4.5"/>
       <text class="ov-label alt" x="${X(altnPoint).toFixed(1)}" y="${(Y(altnPoint) + 19).toFixed(1)}" text-anchor="middle">${escapeHtml(altnPoint.ident || '')}</text>`
    : '';

  return `<div class="cover-track">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(`${first.ident || ''} ${last.ident || ''}`)}">
      ${graticule(X, Y, minX, maxX, minY, maxY, squeeze, W, H)}
      <path class="ov-track" d="${track}"/>
      ${dots}
      ${endpoint(first, first.ident || '')}
      ${endpoint(last, last.ident || '')}
      ${alternate}
    </svg>
  </div>`;
}

/** Whole-degree grid at a step that yields a handful of lines, not a mesh. */
function graticule(X, Y, minX, maxX, minY, maxY, squeeze, W, H) {
  const latSpan = maxY - minY;
  const lonSpan = (maxX - minX) / squeeze;
  const step = (span) => [1, 2, 5, 10, 20, 30].find((s) => span / s <= 6) || 30;

  const latStep = step(latSpan);
  const lonStep = step(lonSpan);
  const lines = [];

  const latFrom = Math.ceil(-maxY / latStep) * latStep;
  for (let lat = latFrom; -lat >= minY; lat += latStep) {
    const y = Y({ lat, lon: 0 });
    if (y > 2 && y < H - 2) lines.push(`<line class="ov-grid" x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}"/>`);
  }

  const lonFrom = Math.ceil((minX / squeeze) / lonStep) * lonStep;
  for (let lon = lonFrom; lon * squeeze <= maxX; lon += lonStep) {
    const x = X({ lat: 0, lon });
    if (x > 2 && x < W - 2) lines.push(`<line class="ov-grid" x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}"/>`);
  }

  return lines.join('');
}

/* -------------------------------------------------------------- airports */

/**
 * One row per airport: weather and the planned runway together, because the
 * runway is what the wind figures are about.
 */
function airportsBody(model) {
  const rows = [
    { airport: model.origin, role: t('nav.departure'), tlr: model.tlr.takeoff },
    { airport: model.destination, role: t('nav.arrival'), tlr: model.tlr.landing },
    ...model.alternates.map((a) => ({ airport: a, role: t('arr.alternate'), tlr: null }))
  ].filter((r) => r.airport);

  return `<div class="apt-list">${rows.map(airportRow).join('')}</div>`;
}

function airportRow({ airport, role, tlr }) {
  const m = airport.metar ? parseMetar(airport.metar) : null;
  const visibility = m?.cavok || m?.visibility?.unlimited
    ? '10+ km'
    : m?.visibility?.metres
    ? `${fmtNumber(m.visibility.metres)} m`
    : '—';

  const runway = tlr?.runways?.find((r) => r.identifier === tlr.plannedRunway) || tlr?.runways?.[0];
  const ident = tlr?.plannedRunway || runway?.identifier || airport.plannedRunway;
  const headwind = runway?.headwind;
  const crosswind = runway?.crosswind;
  const tail = Number.isFinite(headwind) && headwind < 0;

  return `<div class="apt-row">
    <div class="apt-id">
      ${categoryDot(airport.metarCategory)}
      <div>
        <b class="ltr">${escapeHtml(airport.icao)}</b>
        <span>${escapeHtml(role)}</span>
      </div>
    </div>

    <div class="apt-wx">
      <span>${icon('wind', { size: 14 })}<b class="ltr">${escapeHtml(m ? describeWind(m.wind) : '—')}</b></span>
      <span>${icon('visibility', { size: 14 })}<b class="ltr">${escapeHtml(visibility)}</b></span>
      <span>${icon('temperature', { size: 14 })}<b class="ltr">${m && m.temperature !== null ? `${m.temperature}°` : '—'}</b></span>
      ${
        airport.metarCategory
          ? `<span class="chip ${categoryClass(airport.metarCategory)}">${escapeHtml(airport.metarCategory.toUpperCase())}</span>`
          : ''
      }
    </div>

    ${
      ident
        ? `<div class="apt-rwy">
             <span class="k">${escapeHtml(t('common.runway'))}</span>
             <b class="ltr">${escapeHtml(ident)}</b>
             ${
               Number.isFinite(headwind) || Number.isFinite(crosswind)
                 ? `<span class="apt-rwy-wind">
                      ${Number.isFinite(headwind) ? `<i class="${tail ? 'bad' : 'good'}">${escapeHtml(tail ? t('to.tailwind') : t('to.headwind'))} ${Math.abs(headwind)}</i>` : ''}
                      ${Number.isFinite(crosswind) ? `<i class="${crosswind >= 25 ? 'bad' : crosswind >= 15 ? 'warn' : ''}">${escapeHtml(t('to.crosswind'))} ${crosswind}</i>` : ''}
                    </span>`
                 : ''
             }
           </div>`
        : '<div class="apt-rwy"></div>'
    }
  </div>`;
}
