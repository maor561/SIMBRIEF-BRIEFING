/**
 * Weather.
 *
 * Follows the airline-EFB weather page: a WX / CHARTS split, then one block
 * per airport role. Each block leads with the airport's identity and three
 * icon figures (temperature, wind, ceiling), lists its runways, and shows the
 * METAR and TAF as issued -- raw text with the hazardous tokens colour-coded
 * and an age badge, because a crew trusts the string itself, not a rewording
 * of it.
 */

import { t } from '../i18n.js';
import { escapeHtml, fmtNumber, parseMetar, parseTaf, ceilingOf, highlightWx } from '../decode.js';
import { section, icon, chip, categoryDot } from '../ui.js';
import { weatherStrip, buildFixDetail, defaultFix, chartsBody } from '../charts.js';

export default function renderWeather({ model, liveMetar }) {
  // A live METAR supersedes the OFP's snapshot for display; the snapshot is
  // what remains when there is no network.
  const live = liveMetar?.state === 'ready' ? liveMetar.metars : {};
  const withLive = (airport) =>
    airport && live[airport.icao] && live[airport.icao] !== airport.metar
      ? { ...airport, metar: live[airport.icao], metarTime: liveMetar.fetchedAt, metarIsLive: true }
      : airport;

  const alternates = model.alternates.map((a, i) =>
    airportBlock(withLive(a), model.alternates.length > 1 ? `ALTN ${i + 1}` : 'ALTN', [a.plannedRunway], a.plannedRunway)
  );

  return `
    <div class="cover" data-pane-group>
      <div class="pane-tabs">
        <button class="chart-tab" data-action="pane-tab" data-show="wx" aria-selected="true">WX</button>
        <button class="chart-tab" data-action="pane-tab" data-show="charts" aria-selected="false">${escapeHtml(t('wx.tabCharts'))}</button>
      </div>
      ${updatedNote(model, liveMetar)}

      <div class="cover" data-pane="wx">
        ${section(t('dep.title'), null, airportBlock(
          withLive(model.origin),
          'DEP',
          model.tlr.takeoff?.runways?.map((r) => r.identifier),
          model.tlr.takeoff?.plannedRunway || model.origin?.plannedRunway
        ))}
        ${section(t('arr.title'), null, airportBlock(
          withLive(model.destination),
          'DEST',
          model.tlr.landing?.runways?.map((r) => r.identifier),
          model.tlr.landing?.plannedRunway || model.destination?.plannedRunway
        ))}
        ${alternates.length ? section(t('arr.alternate'), null, alternates.join('')) : ''}
        ${section(t('wx.sigmet'), null, sigmetBody(model), { action: sigmetBadge(model) })}
      </div>

      <div class="cover" data-pane="charts" hidden>
        ${section(t('crz.wxStrip'), null, routeWeatherBody(model))}
        ${section(t('crz.charts'), null, chartsBody(model))}
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------- freshness */

/**
 * Says where the weather on screen came from. A live pull is the useful
 * state; without one the OFP snapshot is all there is, and its age is what
 * matters.
 */
function updatedNote(model, liveMetar) {
  const refresh = `<button class="notam-btn" data-action="refresh-metar" title="${escapeHtml(t('wx.refresh'))}" aria-label="${escapeHtml(t('wx.refresh'))}">${icon('routeSwap', { size: 15 })}</button>`;

  if (liveMetar?.state === 'loading') {
    return `<div class="pane-note"><span class="spinner spinner-sm"></span> ${escapeHtml(t('wx.fetchingLive'))}</div>`;
  }

  if (liveMetar?.state === 'ready' && Object.keys(liveMetar.metars).length) {
    const age = ageToken(minutesSince(liveMetar.fetchedAt));
    return `<div class="pane-note live">${escapeHtml(t('wx.liveMetar'))}${age ? ` · <span class="ltr">${age}</span>` : ''} ${refresh}</div>`;
  }

  const age = ageToken(minutesSince(model.generatedAt));
  const failed = liveMetar?.state === 'error';
  return `<div class="pane-note${failed ? ' stale' : ''}">
    ${escapeHtml(failed ? t('wx.liveFailed') : t('wx.fromOfp'))}${age ? ` · ${escapeHtml(t('wx.updated'))} <span class="ltr">${age}</span>` : ''} ${refresh}
  </div>`;
}

function minutesSince(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

function ageToken(minutes) {
  if (minutes === null) return null;
  if (minutes < 120) return `${minutes} MIN`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}H`;
  return `${Math.round(minutes / 1440)}D`;
}

/**
 * METARs run stale after their next issue never showed up; a TAF is only
 * expired once its own validity window has passed. Both get the age badge,
 * only genuinely dead data gets the red EXPIRED.
 */
function metarAgeBadge(airport) {
  if (airport.metarIsLive) {
    return `<span class="wxrow-age live">${escapeHtml(t('wx.live'))}</span>`;
  }
  const minutes = minutesSince(airport.metarTime);
  if (minutes === null) return '';
  if (minutes > 240) return `<span class="wxrow-age bad">${escapeHtml(t('wx.expired'))}</span>`;
  return `<span class="wxrow-age ${minutes > 75 ? 'warn' : ''}"><span class="ltr">${ageToken(minutes)}</span></span>`;
}

function tafAgeBadge(airport) {
  const minutes = minutesSince(airport.tafTime);
  if (minutes === null) return '';
  const issued = new Date(airport.tafTime);
  const parsed = airport.taf ? parseTaf(airport.taf, issued) : null;
  if (parsed?.validTo instanceof Date && !Number.isNaN(parsed.validTo.getTime()) && parsed.validTo < new Date()) {
    return `<span class="wxrow-age bad">${escapeHtml(t('wx.expired'))}</span>`;
  }
  return `<span class="wxrow-age"><span class="ltr">${ageToken(minutes)}</span></span>`;
}

/* --------------------------------------------------------- airport block */

function airportBlock(airport, role, runways, planned) {
  if (!airport) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const m = airport.metar ? parseMetar(airport.metar) : null;
  const name = [airport.icao, airport.iata, airport.name].filter(Boolean).join(' - ');
  const list = (runways || []).filter(Boolean);

  return `
    <div class="wx-head">
      ${categoryDot(airport.metarCategory)}
      <span class="wx-role">${escapeHtml(role)}</span>
      <span class="wx-name ltr">${escapeHtml(name)}</span>
      <span class="grow"></span>
      <div class="wx-stats">
        ${tempStat(m)}
        ${windStat(m)}
        ${ceilingStat(m)}
      </div>
    </div>
    ${
      list.length
        ? `<div class="wx-rwys ltr">RWY ${list
            .map((r) => (r === planned ? `<span class="planned">${escapeHtml(r)}</span>` : escapeHtml(r)))
            .join(' ')}</div>`
        : ''
    }
    ${wxRow(t('wx.metar'), metarAgeBadge(airport), airport.metar)}
    ${wxRow(t('wx.taf'), tafAgeBadge(airport), airport.taf)}
  `;
}

function wxRow(label, badge, raw) {
  if (!raw) return '';
  return `<div class="wxrow">
    <div class="wxrow-head">
      <span class="wxrow-label">${escapeHtml(label)}</span>
      ${badge}
    </div>
    <div class="wxrow-text">${highlightWx(raw)}</div>
  </div>`;
}

/* Three figures a crew reads off the block without opening the METAR. */

function tempStat(m) {
  if (!m || m.temperature === null) return '';
  const f = Math.round((m.temperature * 9) / 5 + 32);
  return `<span class="wx-stat">${icon('temperature', { size: 16 })}<b class="ltr">${m.temperature}°C</b><i class="ltr">(${f}°F)</i></span>`;
}

function windStat(m) {
  if (!m?.wind) return '';
  const w = m.wind;
  const text = w.calm
    ? 'CALM'
    : `${w.direction === null ? 'VRB' : `${String(w.direction).padStart(3, '0')}°`} ${w.speed ?? '—'}${w.gust ? `G${w.gust}` : ''} KT`;
  return `<span class="wx-stat">${icon('wind', { size: 16 })}<b class="ltr">${escapeHtml(text)}</b></span>`;
}

function ceilingStat(m) {
  if (!m) return '';
  if (m.cavok) return `<span class="wx-stat">${icon('ceiling', { size: 16 })}<b class="ltr">CAVOK</b></span>`;
  const base = ceilingOf(m);
  if (base === null) return `<span class="wx-stat">${icon('ceiling', { size: 16 })}<b class="ltr">—</b></span>`;
  const layer = m.clouds.find((c) => ['BKN', 'OVC', 'VV'].includes(c.amount) && c.baseFt === base);
  return `<span class="wx-stat">${icon('ceiling', { size: 16 })}<b class="ltr">${escapeHtml(layer?.amount || '')} ${fmtNumber(base)} ft</b></span>`;
}

/* ----------------------------------------------------------------- SIGMET */

function sigmetBadge(model) {
  const count = model.sigmets?.length || 0;
  return count
    ? `<span class="sect-flag warn">${count}</span>`
    : `<span class="sect-flag good">0</span>`;
}

function sigmetBody(model) {
  const items = model.sigmets || [];
  if (!items.length) {
    return `<div class="empty-state good">${escapeHtml(t('wx.sigmetEmpty'))}</div>`;
  }
  return `<div class="sect-pad">${items
    .map(
      (s) => `<div style="margin-block-end:11px">
        ${s.fir ? chip(s.fir, 'blue') : ''}
        <div class="wxrow-text" style="margin-block-start:6px">${highlightWx(s.text)}</div>
      </div>`
    )
    .join('')}</div>`;
}

/* ------------------------------------------------------------ route strip */

function routeWeatherBody(model) {
  return `
    <div class="img-note" style="padding:11px 15px 0">${escapeHtml(t('crz.wxStripHint'))}</div>
    ${weatherStrip(model)}
    <div class="sect-pad"><div data-fix-detail>${buildFixDetail(defaultFix(model), model)}</div></div>
  `;
}
