/**
 * Chapter 0 — Overview.
 *
 * The cover page. Everything here answers "where am I flying, when, and is
 * anything wrong" before the crew opens a single phase chapter. It stays out
 * of the masonry grid on purpose: this page is a fixed composition read
 * top-to-bottom, not a wall of independent cards.
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
import { icon, categoryDot } from '../ui.js';
import { dominantCruiseAltitude } from './cruise.js';
import { SEVERITY } from '../analyze.js';

export default function renderOverview({ model, findings }) {
  const critical = findings.filter((f) => f.severity === SEVERITY.CRITICAL).length;
  const units = model.units === 'lbs' ? 'lb' : 'kg';

  return `
    <div class="cover">
      ${identityBar(model, findings, critical)}
      ${journey(model)}
      ${mapBlock(model)}
      ${numbersStrip(model, units)}
      ${runwayStrip(model)}
      ${weatherStrip(model)}
    </div>
  `;
}

/* ------------------------------------------------------------- identity */

function identityBar(model, findings, critical) {
  const f = model.flight;
  const badge = findings.length
    ? `<span class="cover-flag ${critical ? 'bad' : 'warn'}">
         ${icon('obstacle', { size: 14 })}${findings.length} ${escapeHtml(t('sum.watchItems'))}
       </span>`
    : `<span class="cover-flag good">${icon('info', { size: 14 })}${escapeHtml(t('sum.clean'))}</span>`;

  return `<div class="cover-id">
    <span class="cover-callsign ltr">${escapeHtml(f.callsign || f.number || '')}</span>
    <span class="cover-type ltr">${escapeHtml([f.aircraftIcao, f.registration].filter(Boolean).join(' · '))}</span>
    <span class="grow"></span>
    ${badge}
  </div>`;
}

/* -------------------------------------------------------------- journey */

/**
 * The two ends of the flight at full size with the route between them.
 * Reads left-to-right in both languages, the way a departure board does.
 */
function journey(model) {
  const cruiseAlt = dominantCruiseAltitude(model) || model.flight.initialAltitude;
  const enroute = model.times.estTimeEnroute ?? model.times.estBlock;

  const end = (airport, timeLabel, time) => `
    <div class="cover-end">
      <span class="cover-icao ltr">${escapeHtml(airport?.icao || '—')}</span>
      <span class="cover-city">${escapeHtml(cityOf(airport))}</span>
      <span class="cover-when">
        ${categoryDot(airport?.metarCategory)}
        <span class="ltr">${escapeHtml(fmtZulu(time))}</span>
        <span class="cover-when-label">${escapeHtml(timeLabel)}</span>
      </span>
    </div>`;

  return `<div class="cover-journey">
    ${end(model.origin, t('header.etd'), model.times.estOff || model.times.schedOff)}

    <div class="cover-path">
      <span class="cover-level ltr">${cruiseAlt ? `FL${Math.round(cruiseAlt / 100)}` : '—'}${
        model.flight.costIndex === null || model.flight.costIndex === undefined ? '' : ` · CI ${model.flight.costIndex}`
      }</span>
      <span class="cover-line"><span class="cover-plane">${icon('aircraft', { size: 13 })}</span></span>
      <span class="cover-sub ltr">${fmtDuration(enroute)} · ${fmtNumber(model.route.distance)} nm</span>
    </div>

    ${end(model.destination, t('dep.landingTime'), model.times.estOn || model.times.schedOn)}
  </div>`;
}

/** SimBrief names airports "CITY/FIELD NAME"; the first part is the city. */
function cityOf(airport) {
  const name = airport?.name || '';
  return name.split('/')[0].trim();
}

/* ------------------------------------------------------------------ map */

function mapBlock(model) {
  const track = trackSvg(model);
  const chart = model.images.route;
  if (!track && !chart) return '';

  // With only one of the two available there is nothing to switch between.
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
  // can't produce a absurdly tall panel either.
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
      ${graticule(all, X, Y, minX, maxX, minY, maxY, squeeze, W, H)}
      <path class="ov-track" d="${track}"/>
      ${dots}
      ${endpoint(first, first.ident || '')}
      ${endpoint(last, last.ident || '')}
      ${alternate}
    </svg>
  </div>`;
}

/** Whole-degree grid at a step that yields a handful of lines, not a mesh. */
function graticule(all, X, Y, minX, maxX, minY, maxY, squeeze, W, H) {
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

  const lonFrom = Math.ceil(minX / squeeze / lonStep) * lonStep;
  for (let lon = lonFrom; lon * squeeze <= maxX; lon += lonStep) {
    const x = X({ lat: 0, lon });
    if (x > 2 && x < W - 2) lines.push(`<line class="ov-grid" x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}"/>`);
  }

  return lines.join('');
}

/* -------------------------------------------------------------- numbers */

function numbersStrip(model, units) {
  const cell = (label, value, unit = '') =>
    `<div class="cover-cell">
       <span class="k">${escapeHtml(label)}</span>
       <span class="v ltr">${value}${unit ? `<i>${escapeHtml(unit)}</i>` : ''}</span>
     </div>`;

  return `<div class="cover-numbers">
    ${cell(t('dep.pax'), fmtNumber(model.weights.paxCount))}
    ${cell(t('sum.blockFuel'), fmtNumber(model.fuel.planRamp), units)}
    ${cell(t('sum.blockTime'), fmtDuration(model.times.estBlock))}
    ${cell(t('dep.tow'), fmtNumber(model.weights.estTow), units)}
  </div>`;
}

/* -------------------------------------------------------------- runways */

/** Planned runway at each end, with the wind the plan was built on. */
function runwayStrip(model) {
  const side = (tlr, fallbackRunway, role) => {
    const runway = tlr?.runways?.find((r) => r.identifier === tlr.plannedRunway) || tlr?.runways?.[0];
    const ident = tlr?.plannedRunway || runway?.identifier || fallbackRunway;
    if (!ident) return '';

    const headwind = runway?.headwind;
    const crosswind = runway?.crosswind;
    const tail = Number.isFinite(headwind) && headwind < 0;

    return `<div class="cover-rwy">
      <span class="cover-rwy-role">${escapeHtml(role)}</span>
      <span class="cover-rwy-id ltr">${escapeHtml(ident)}</span>
      <span class="cover-rwy-wind">
        ${
          Number.isFinite(headwind)
            ? `<span class="${tail ? 'bad' : 'good'}">${escapeHtml(tail ? t('to.tailwind') : t('to.headwind'))} <b class="ltr">${Math.abs(headwind)}</b></span>`
            : ''
        }
        ${
          Number.isFinite(crosswind)
            ? `<span class="${crosswind >= 25 ? 'bad' : crosswind >= 15 ? 'warn' : ''}">${escapeHtml(t('to.crosswind'))} <b class="ltr">${crosswind}</b></span>`
            : ''
        }
      </span>
    </div>`;
  };

  const departure = side(model.tlr.takeoff, model.origin?.plannedRunway, t('nav.departure'));
  const arrival = side(model.tlr.landing, model.destination?.plannedRunway, t('nav.arrival'));
  if (!departure && !arrival) return '';

  return `<div class="cover-runways">${departure}${arrival}</div>`;
}

/* -------------------------------------------------------------- weather */

function weatherStrip(model) {
  const entries = [
    { airport: model.origin, role: t('nav.departure') },
    { airport: model.destination, role: t('nav.arrival') },
    ...model.alternates.map((a) => ({ airport: a, role: t('arr.alternate') }))
  ].filter((e) => e.airport);

  return `<div class="cover-wx">${entries
    .map(({ airport, role }) => {
      const m = airport.metar ? parseMetar(airport.metar) : null;
      const visibility = m?.cavok || m?.visibility?.unlimited
        ? '10+ km'
        : m?.visibility?.metres
        ? `${fmtNumber(m.visibility.metres)} m`
        : '—';

      return `<div class="cover-wx-cell">
        <div class="cover-wx-top">
          ${categoryDot(airport.metarCategory)}
          <span class="ltr icao">${escapeHtml(airport.icao)}</span>
          <span class="role">${escapeHtml(role)}</span>
          ${
            airport.metarCategory
              ? `<span class="chip ${categoryClass(airport.metarCategory)}">${escapeHtml(airport.metarCategory.toUpperCase())}</span>`
              : ''
          }
        </div>
        <div class="cover-wx-figs">
          <span>${icon('wind', { size: 14 })}<b class="ltr">${escapeHtml(m ? describeWind(m.wind) : '—')}</b></span>
          <span>${icon('visibility', { size: 14 })}<b class="ltr">${escapeHtml(visibility)}</b></span>
          <span>${icon('temperature', { size: 14 })}<b class="ltr">${m && m.temperature !== null ? `${m.temperature}°` : '—'}</b></span>
        </div>
      </div>`;
    })
    .join('')}</div>`;
}
