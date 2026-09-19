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
import {
  escapeHtml,
  fmtNumber,
  fmtZulu,
  fmtZuluDate,
  parseMetar,
  parseTaf,
  parseTafGroupBody,
  parseSigmet,
  ceilingOf,
  highlightWx,
  flightCategory,
  categoryClass,
  describeWind
} from '../decode.js';
import { section, icon, chip, categoryDot, windRose } from '../ui.js';
import { runwayWind, estimateRunwayCourse } from '../wind.js';
import { weatherStrip, buildFixDetail, defaultFix, chartsBody, dominantCruiseAltitude } from '../charts.js';

export default function renderWeather({ model, liveMetar }) {
  // A live METAR supersedes the OFP's snapshot for display; the snapshot is
  // what remains when there is no network.
  const live = liveMetar?.state === 'ready' ? liveMetar.metars : {};
  const withLive = (airport) => {
    if (!airport || !live[airport.icao] || live[airport.icao] === airport.metar) return airport;
    const raw = live[airport.icao];
    // The category dot has to follow the observation on screen, or the block
    // shows current weather under the planned colour.
    const category = flightCategory(parseMetar(raw)) || airport.metarCategory;
    return {
      ...airport,
      metar: raw,
      metarTime: liveMetar.fetchedAt,
      metarIsLive: true,
      metarCategory: category
    };
  };

  const alternates = model.alternates.map((a, i) =>
    airportBlock(
      withLive(a),
      model.alternates.length > 1 ? `ALTN ${i + 1}` : 'ALTN',
      [a.plannedRunway],
      a.plannedRunway,
      estimateRunwayCourse(a.plannedRunway),
      null
    )
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
          model.tlr.takeoff?.plannedRunway || model.origin?.plannedRunway,
          courseFor(model.tlr.takeoff?.runways, model.tlr.takeoff?.plannedRunway || model.origin?.plannedRunway),
          model.times.estOff
        ))}
        ${section(t('arr.title'), null, airportBlock(
          withLive(model.destination),
          'DEST',
          model.tlr.landing?.runways?.map((r) => r.identifier),
          model.tlr.landing?.plannedRunway || model.destination?.plannedRunway,
          courseFor(model.tlr.landing?.runways, model.tlr.landing?.plannedRunway || model.destination?.plannedRunway),
          model.times.estOn
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

/** The takeoff/landing runway SimBrief actually resolved a true course for. */
function courseFor(runways, planned) {
  return runways?.find((r) => r.identifier === planned)?.trueCourse ?? null;
}

function airportBlock(airport, role, runways, planned, windCourse = null, etaReference = null) {
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
    ${wxRow(
      t('wx.metar'),
      metarAgeBadge(airport),
      airport.metar,
      m ? metarDecodePanel(m, { course: windCourse, category: airport.metarCategory }) : ''
    )}
    ${wxRow(t('wx.taf'), tafAgeBadge(airport), airport.taf, tafDecodePanel(airport, etaReference))}
  `;
}

/**
 * A raw report's row, plus -- when a decode exists -- a collapsed graphic
 * panel a crew can open without losing the string they actually trust. The
 * toggle is a pure DOM class flip (see app.js `wx-decode-toggle`), so opening
 * a panel never triggers a re-render and never disturbs scroll position.
 */
function wxRow(label, badge, raw, decodeHtml) {
  if (!raw) return '';
  const hasDecode = Boolean(decodeHtml);
  return `<div class="wxrow">
    <div class="wxrow-head">
      <span class="wxrow-label">${escapeHtml(label)}</span>
      ${badge}
      <span class="grow"></span>
      ${
        hasDecode
          ? `<button class="wx-decode-btn" data-action="wx-decode-toggle" aria-expanded="false"
               title="${escapeHtml(t('wx.decodeShow'))}" aria-label="${escapeHtml(t('wx.decodeShow'))}">
               ${icon('chevronDown', { size: 14 })}
             </button>`
          : ''
      }
    </div>
    <div class="wxrow-text">${highlightWx(raw)}</div>
    ${hasDecode ? `<div class="wx-decode">${decodeHtml}</div>` : ''}
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

/* -------------------------------------------------------- METAR graphic */

/**
 * The figures a crew would otherwise have to read out of the string
 * themselves: a compass for the wind (swept against the runway when one is
 * known), a visibility bar, a cloud-layer profile, temperature/dewpoint and
 * pressure, closed with a row of hazard chips for whatever in the report
 * actually changes the plan.
 */
function metarDecodePanel(m, { course = null, category = null } = {}) {
  const resolved = m.wind && !m.wind.calm && !m.wind.variable ? runwayWind({ trueCourse: course }, m) : null;
  const hazards = wxHazardChips(m);

  return `
    <div class="wxd-grid">
      ${wxdTile(t('wx.decodeWind'), windTileBody(m.wind, course, resolved))}
      ${wxdTile(t('wx.decodeVisibility'), visibilityTileBody(m))}
      ${wxdTile(t('wx.decodeClouds'), cloudsTileBody(m))}
      ${wxdTile(t('wx.decodeTemp'), tempTileBody(m))}
      ${wxdTile(t('wx.decodePressure'), pressureTileBody(m, category))}
    </div>
    ${hazards ? `<div class="wxd-hazards">${hazards}</div>` : ''}
  `;
}

function wxdTile(label, body) {
  return `<div class="wxd-tile"><span class="wxd-label">${escapeHtml(label)}</span>${body}</div>`;
}

function windTileBody(wind, course, resolved) {
  if (!wind) return `<div class="wxd-empty">—</div>`;
  const dirText = wind.calm ? t('wx.calm') : wind.variable ? t('wx.decodeVariable') : `${String(wind.direction).padStart(3, '0')}°`;
  const speedText = wind.calm ? '' : `${wind.speed}${wind.gust ? `<i class="wxd-gust">G${wind.gust}</i>` : ''} kt`;

  const sub = [];
  if (wind.varyFrom !== null) {
    sub.push(`${String(wind.varyFrom).padStart(3, '0')}°–${String(wind.varyTo).padStart(3, '0')}°`);
  }
  if (resolved && Number.isFinite(resolved.headwind)) {
    const hw = resolved.headwind;
    sub.push(`${Math.abs(hw)} kt ${hw < 0 ? t('to.tailShort') : t('to.headShort')}`);
    sub.push(`${resolved.worstCrosswind} kt XW`);
  }

  return `
    ${windRose(wind.direction, wind.speed, Number.isFinite(course) ? course : null)}
    <b class="ltr">${escapeHtml(dirText)}${speedText ? ` ${speedText}` : ''}</b>
    ${sub.length ? `<span class="wxd-sub ltr">${sub.map(escapeHtml).join(' · ')}</span>` : ''}
  `;
}

function visibilityTileBody(m) {
  if (m.cavok) {
    return `<b class="ltr">${escapeHtml(t('wx.decodeCavok'))}</b><span class="wxd-sub">${escapeHtml(t('wx.cavok'))}</span>`;
  }
  const metres = m.visibility?.unlimited ? 10000 : m.visibility?.metres ?? null;
  if (metres === null) return `<div class="wxd-empty">—</div>`;

  const pct = Math.max(3, Math.min(100, (metres / 10000) * 100));
  const tone = metres < 1600 ? 'bad' : metres < 5000 ? 'warn' : 'good';
  const weatherText = m.weather.map((w) => w.text).filter(Boolean).join(', ');

  return `
    <div class="wxd-meter"><div class="wxd-meter-fill ${tone}" style="width:${pct.toFixed(1)}%"></div></div>
    <b class="ltr">${metres >= 10000 ? '10+ km' : `${fmtNumber(metres)} m`}</b>
    ${weatherText ? `<span class="wxd-sub">${escapeHtml(weatherText)}</span>` : ''}
  `;
}

function cloudsTileBody(m) {
  if (m.cavok) {
    return `<b class="ltr">${escapeHtml(t('wx.decodeCavok'))}</b><span class="wxd-sub">${escapeHtml(t('wx.decodeSkyClear'))}</span>`;
  }
  if (!m.clouds.length) return `<div class="wxd-empty">—</div>`;

  const layers = m.clouds.filter((c) => c.baseFt !== null);
  if (!layers.length) {
    return `<b class="ltr">${escapeHtml(m.clouds[0].amountText || m.clouds[0].amount)}</b>`;
  }

  const maxFt = Math.max(...layers.map((c) => c.baseFt), 5000);
  const bars = layers
    .map((c) => {
      const h = Math.max(6, Math.round((c.baseFt / maxFt) * 38));
      const bad = c.convective === 'CB' || (['BKN', 'OVC', 'VV'].includes(c.amount) && c.baseFt <= 500);
      const warn = !bad && ['BKN', 'OVC', 'VV'].includes(c.amount) && c.baseFt <= 1000;
      const title = `${c.amount}${c.convective ? ` ${c.convective}` : ''} ${fmtNumber(c.baseFt)} ft`;
      return `<div class="wxd-cloud-bar${bad ? ' bad' : warn ? ' warn' : ''}" style="height:${h}px" title="${escapeHtml(title)}">
        <span>${escapeHtml(c.amount)}${c.convective ? ` ${escapeHtml(c.convective)}` : ''}</span>
      </div>`;
    })
    .join('');

  const ceiling = ceilingOf(m);
  return `
    <div class="wxd-cloud-profile">${bars}</div>
    <span class="wxd-sub ltr">${
      ceiling !== null
        ? `${escapeHtml(t('wx.decodeCeiling'))} ${fmtNumber(ceiling)} ft`
        : escapeHtml(t('wx.decodeNoCeiling'))
    }</span>
  `;
}

function tempTileBody(m) {
  if (m.temperature === null) return `<div class="wxd-empty">—</div>`;
  const spread = m.dewpoint !== null ? m.temperature - m.dewpoint : null;
  return `
    <b class="ltr">${m.temperature}° / ${m.dewpoint === null ? '—' : `${m.dewpoint}°`}</b>
    ${spread !== null ? `<span class="wxd-sub">${escapeHtml(t('wx.decodeSpread'))} ${spread}°</span>` : ''}
  `;
}

function pressureTileBody(m, category) {
  const figs = [];
  if (m.qnhHpa) figs.push(`<b class="ltr">${m.qnhHpa} hPa</b>`);
  if (m.qnhInHg) figs.push(`<span class="wxd-sub ltr">${m.qnhInHg.toFixed(2)} inHg</span>`);
  if (!figs.length) figs.push(`<div class="wxd-empty">—</div>`);

  const catChip = category
    ? `<span class="chip ${categoryClass(category)}">${categoryDot(category)}${escapeHtml(t(`wx.category.${category}`, category.toUpperCase()))}</span>`
    : '';

  return `${figs.join('')}${catChip ? `<div class="wxd-tile-foot">${catChip}</div>` : ''}`;
}

/** The row of hazard chips under the tiles: what in this report actually changes the plan. */
function wxHazardChips(m) {
  const chips = [];

  m.weather.forEach((w) => {
    if (w.text) chips.push(chip(w.text, w.intensity === 'heavy' ? 'red' : 'amber'));
  });
  if (m.clouds.some((c) => c.convective === 'CB')) chips.push(chip(t('wx.decodeCB'), 'red'));
  else if (m.clouds.some((c) => c.convective === 'TCU')) chips.push(chip(t('wx.decodeTCU'), 'amber'));
  if (m.wind?.gust) chips.push(chip(`${t('wx.decodeGusting')} ${m.wind.gust} kt`, 'amber'));

  const ceiling = ceilingOf(m);
  if (ceiling !== null && ceiling < 1000) chips.push(chip(t('wx.decodeLowCeiling'), ceiling < 500 ? 'red' : 'amber'));

  const metres = m.cavok ? null : m.visibility?.unlimited ? null : m.visibility?.metres ?? null;
  if (metres !== null && metres < 5000) chips.push(chip(t('wx.decodeLowVis'), metres < 1600 ? 'red' : 'amber'));

  return chips.join('');
}

/* ---------------------------------------------------------- TAF graphic */

/**
 * TAF groups don't happen in the base period's own text -- a bare "PROB30"
 * split ahead of the TEMPO it actually qualifies is a separate group with no
 * validity window of its own. Folded back together here so the timeline
 * shows one "PROB30 TEMPO" band rather than an orphan probability marker.
 */
function mergedTafGroups(groups) {
  const merged = [];
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    if (g.kind === 'PROB' && !g.from && groups[i + 1]) {
      merged.push({ ...groups[i + 1], probability: g.probability });
      i += 1;
    } else {
      merged.push(g);
    }
  }
  return merged;
}

const TAF_LANES = [
  { key: 'base', label: t('wx.tafBase'), match: (g) => g.kind === 'base' || g.kind === 'FM' },
  { key: 'becmg', label: 'BECMG', match: (g) => g.kind === 'BECMG' },
  { key: 'tempo', label: 'TEMPO', match: (g) => g.kind === 'TEMPO' || g.kind === 'INTER' },
  { key: 'prob', label: 'PROB', match: (g) => g.kind === 'PROB' }
];

function tafBodyHazard(body) {
  if (!body) return false;
  if (body.weather.some((w) => w.intensity === 'heavy' || w.codes.includes('TS'))) return true;
  if (body.clouds.some((c) => c.convective === 'CB')) return true;
  if (body.wind?.gust && body.wind.gust >= 25) return true;
  if (body.visibility && !body.visibility.unlimited && body.visibility.metres < 1600) return true;
  return false;
}

/** Short label for a group's band -- the one or two things worth glancing at. */
function tafGroupSummary(body) {
  if (!body) return '';
  const bits = [];
  if (body.weather.some((w) => w.codes.includes('TS'))) bits.push('TS');
  if (body.clouds.some((c) => c.convective === 'CB')) bits.push('CB');
  if (!bits.length) {
    const weatherText = body.weather[0]?.text;
    if (weatherText) bits.push(weatherText);
  }
  if (body.wind?.gust) bits.push(`G${body.wind.gust}`);
  if (!body.cavok && body.visibility && !body.visibility.unlimited && body.visibility.metres < 5000) {
    bits.push(`${fmtNumber(body.visibility.metres)}m`);
  }
  if (!bits.length && body.wind) bits.push(body.wind.calm ? 'CALM' : `${body.wind.speed}kt`);
  return bits.slice(0, 2).join(' · ');
}

/** Fuller line for the legend under the timeline. */
function tafGroupDetail(body) {
  if (!body) return '';
  const parts = [];
  if (body.cavok) parts.push('CAVOK');
  if (body.wind) parts.push(describeWind(body.wind));
  if (!body.cavok && body.visibility) {
    parts.push(body.visibility.unlimited ? '10+ km' : `${fmtNumber(body.visibility.metres)} m`);
  }
  const weatherText = body.weather.map((w) => w.text).filter(Boolean).join(', ');
  if (weatherText) parts.push(weatherText);
  const cloudText = body.clouds
    .map((c) => `${c.amount}${c.convective ? ` ${c.convective}` : ''}${c.baseFt !== null ? ` ${fmtNumber(c.baseFt)}ft` : ''}`)
    .join(', ');
  if (cloudText) parts.push(cloudText);
  return parts.filter(Boolean).join(' · ');
}

function groupKindLabel(g) {
  if (g.kind === 'base') return t('wx.tafBase');
  if (g.kind === 'FM') return `FM ${fmtZulu(g.from)}`;
  if (g.probability) return `PROB${g.probability}${g.kind === 'TEMPO' || g.kind === 'INTER' ? ` ${g.kind}` : ''}`;
  return g.kind;
}

/**
 * The TAF as a timeline: one lane per kind of group, positioned by its own
 * validity window against the TAF's overall span, with the flight's ETA/ETD
 * at this airport marked across every lane. Falls back to nothing rather
 * than a broken axis when the validity window itself failed to parse.
 */
function tafDecodePanel(airport, etaReference) {
  if (!airport.taf) return '';
  const issued = airport.tafTime ? new Date(airport.tafTime) : new Date();
  const taf = parseTaf(airport.taf, issued);
  if (!(taf.validFrom instanceof Date) || !(taf.validTo instanceof Date) || taf.validTo <= taf.validFrom) return '';

  const span = taf.validTo.getTime() - taf.validFrom.getTime();
  const pct = (date) => Math.max(0, Math.min(100, ((date.getTime() - taf.validFrom.getTime()) / span) * 100));

  const groups = mergedTafGroups(taf.groups);
  // A base segment's displayed span ends where the next FM segment (if any)
  // picks it up -- parseTaf itself only needs the whole-TAF window for
  // groupCovers, but drawing every base group full-width would overlap them.
  const baseGroups = groups.filter((g) => g.kind === 'base' || g.kind === 'FM');

  const eta = etaReference instanceof Date && !Number.isNaN(etaReference.getTime()) ? etaReference : null;
  const etaInWindow = eta && eta >= taf.validFrom && eta <= taf.validTo;

  const lanes = TAF_LANES.map((lane) => {
    const inLane = lane.key === 'base' ? baseGroups : groups.filter(lane.match);
    if (!inLane.length) return '';
    const bands = inLane
      .map((g) => {
        const from = g.from || taf.validFrom;
        const to = g.to || taf.validTo;
        const left = pct(from);
        const width = Math.max(1.5, pct(to) - left);
        const body = parseTafGroupBody(g.text);
        const hazard = tafBodyHazard(body);
        const cls = hazard ? 'hazard' : lane.key;
        const label = tafGroupSummary(body) || groupKindLabel(g);
        const title = `${groupKindLabel(g)} ${fmtZuluDate(from)} – ${fmtZuluDate(to)}`;
        return `<span class="wxd-taf-band ${cls}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
      })
      .join('');
    return `<div class="wxd-taf-lane-label">${escapeHtml(lane.label)}</div><div class="wxd-taf-row">${bands}</div>`;
  }).join('');

  const legend = groups
    .map((g) => {
      const from = g.from || taf.validFrom;
      const to = g.to || taf.validTo;
      const body = parseTafGroupBody(g.text);
      const detail = tafGroupDetail(body);
      if (!detail) return '';
      return `<div class="wxd-taf-legend-row">
        <b class="ltr">${escapeHtml(groupKindLabel(g))}</b>
        <span class="ltr">${escapeHtml(fmtZuluDate(from))} – ${escapeHtml(fmtZuluDate(to))}</span>
        <span>${escapeHtml(detail)}</span>
      </div>`;
    })
    .join('');

  return `
    <div class="wxd-taf-axis">
      ${lanes}
      <div class="wxd-taf-overlay">${
        etaInWindow
          ? `<div class="wxd-taf-eta" style="left:${pct(eta).toFixed(2)}%"><i>${escapeHtml(t('wx.tafEta'))}</i></div>`
          : ''
      }</div>
    </div>
    ${legend ? `<div class="wxd-taf-legend">${legend}</div>` : ''}
  `;
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
    .map((s) => sigmetItem(s, dominantCruiseAltitude(model) || model.flight.initialAltitude))
    .join('')}</div>`;
}

function sigmetItem(s, cruiseAltitude) {
  const parsed = parseSigmet(s.text);
  const decodeHtml = sigmetDecodePanel(parsed, cruiseAltitude);
  return `<div class="wxrow sigmet-item">
    <div class="wxrow-head">
      ${s.fir ? chip(s.fir, 'blue') : ''}
      ${parsed?.hazard ? chip(parsed.hazard, 'red') : ''}
      <span class="grow"></span>
      ${
        decodeHtml
          ? `<button class="wx-decode-btn" data-action="wx-decode-toggle" aria-expanded="false"
               title="${escapeHtml(t('wx.decodeShow'))}" aria-label="${escapeHtml(t('wx.decodeShow'))}">
               ${icon('chevronDown', { size: 14 })}
             </button>`
          : ''
      }
    </div>
    <div class="wxrow-text">${highlightWx(s.text, 'sigmet')}</div>
    ${decodeHtml ? `<div class="wx-decode">${decodeHtml}</div>` : ''}
  </div>`;
}

/** Validity, movement/trend and the vertical band the hazard occupies, against the planned cruise level. */
function sigmetDecodePanel(sigmet, cruiseAltitude) {
  if (!sigmet) return '';

  const now = new Date();
  const hasWindow = sigmet.validFrom instanceof Date && sigmet.validTo instanceof Date;
  const status = !hasWindow ? null : now < sigmet.validFrom ? 'upcoming' : now > sigmet.validTo ? 'expired' : 'active';
  const statusChip = status
    ? chip(t(`wx.sigmet${status[0].toUpperCase()}${status.slice(1)}`), status === 'active' ? 'red' : status === 'upcoming' ? 'amber' : '')
    : '';

  const chips = [statusChip];
  if (sigmet.movement?.stationary) chips.push(chip(t('wx.sigmetStationary'), 'blue'));
  else if (sigmet.movement) chips.push(chip(`${sigmet.movement.directionText || sigmet.movement.direction} ${sigmet.movement.speed} kt`, 'blue'));
  if (sigmet.trend) chips.push(chip(sigmet.trend));

  const validText = hasWindow ? `${fmtZuluDate(sigmet.validFrom)} – ${fmtZuluDate(sigmet.validTo)}` : null;

  return `
    <div class="wxd-sigmet">
      <div class="wxd-sigmet-info">
        ${chips.filter(Boolean).length ? `<div class="wxd-hazards">${chips.filter(Boolean).join('')}</div>` : ''}
        ${validText ? wxdTile(t('wx.sigmetValid'), `<b class="ltr">${escapeHtml(validText)}</b>`) : ''}
      </div>
      ${sigmet.top !== null ? sigmetAltitudeBand(sigmet, cruiseAltitude) : ''}
    </div>
  `;
}

function sigmetAltitudeBand(sigmet, cruiseAltitude) {
  const scale = Math.max(sigmet.top, cruiseAltitude || 0, 10000) * 1.15;
  const baseFt = sigmet.base ?? 0;
  const bottomPct = (baseFt / scale) * 100;
  const heightPct = ((sigmet.top - baseFt) / scale) * 100;
  const cruisePct = cruiseAltitude ? (cruiseAltitude / scale) * 100 : null;
  const topLabel = `${sigmet.topAbove ? `${t('wx.sigmetAbove')} ` : ''}FL${Math.round(sigmet.top / 100)}`;
  const baseLabel = sigmet.base === null ? '' : sigmet.base === 0 ? 'SFC' : `FL${Math.round(sigmet.base / 100)}`;

  return `<div class="wxd-sigmet-alt">
    <span class="wxd-label">${escapeHtml(t('wx.sigmetExtent'))}</span>
    <div class="wxd-sigmet-alt-track">
      <span class="wxd-sigmet-alt-top ltr">${escapeHtml(topLabel)}</span>
      <span class="wxd-sigmet-alt-base ltr">${escapeHtml(baseLabel || 'SFC')}</span>
      <div class="wxd-sigmet-alt-band" style="bottom:${bottomPct.toFixed(1)}%;height:${Math.max(2, heightPct).toFixed(1)}%"></div>
      ${cruisePct !== null ? `<div class="wxd-sigmet-cruise" style="bottom:${cruisePct.toFixed(1)}%"><i>${escapeHtml(t('wx.cruiseLevel'))} FL${Math.round(cruiseAltitude / 100)}</i></div>` : ''}
    </div>
  </div>`;
}

/* ------------------------------------------------------------ route strip */

function routeWeatherBody(model) {
  return `
    <div class="img-note" style="padding:11px 15px 0">${escapeHtml(t('crz.wxStripHint'))}</div>
    ${weatherStrip(model)}
    <div class="sect-pad"><div data-fix-detail>${buildFixDetail(defaultFix(model), model)}</div></div>
  `;
}
