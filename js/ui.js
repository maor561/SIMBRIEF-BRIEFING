/**
 * Shared building blocks for the chapters.
 *
 * Everything here returns an HTML string. Interactive pieces mark themselves
 * with `data-action` and are wired up by delegated handlers in app.js, so views
 * stay declarative.
 */

import { t, getLang } from './i18n.js';
import {
  escapeHtml,
  sanitizeNotamHtml,
  fmtNumber,
  fmtFeet,
  fmtWeight,
  fmtZulu,
  fmtZuluDate,
  parseMetar,
  parseTaf,
  groupCovers,
  describeWind,
  ceilingOf,
  categoryClass,
  notamSeverity,
  notamActiveDuring,
  decodeSurface
} from './decode.js';
import { severityClass, severityLabel, SEVERITY } from './analyze.js';

export const html = (strings, ...values) =>
  strings.reduce((out, chunk, i) => out + chunk + (values[i] ?? ''), '');

/**
 * Joins the parts that actually have a value.
 * Plenty of OFP fields are optional (no SID, no STAR), and interpolating them
 * straight into a heading leaves a dangling separator.
 */
export function joinParts(parts, separator = ' · ') {
  return parts.filter((part) => part !== null && part !== undefined && String(part).trim() !== '').join(separator);
}

/* ------------------------------------------------------------------- cards */

export function card({ title, hint, badge, body, cls = '', headless = false }) {
  const header = headless
    ? ''
    : `<header>
         <h2>${escapeHtml(title || '')}</h2>
         ${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}
         <span class="grow"></span>
         ${badge || ''}
       </header>`;
  return `<section class="card ${cls}">${header}<div class="body">${body}</div></section>`;
}

/** A card whose body sits flush against the edges (tables, lists, charts). */
export function flushCard(opts) {
  return card({ ...opts, cls: `flush ${opts.cls || ''}` });
}

export function collapsible({ title, badge, body, open = false, cls = '' }) {
  return `<details class="card ${cls}" ${open ? 'open' : ''}>
    <summary>${escapeHtml(title)}${badge ? ` ${badge}` : ''}</summary>
    <div class="body">${body}</div>
  </details>`;
}

/* ------------------------------------------------------------------- tiles */

/**
 * A single figure. `tone` drives colour: good / warn / bad / info.
 * `size` accepts 'big' or 'huge' for the numbers that deserve the room.
 */
export function tile({ label, value, unit, hint, tone = '', size = '' }) {
  return `<div class="tile ${tone} ${size}">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${value ?? '—'}${unit ? `<span class="unit">${escapeHtml(unit)}</span>` : ''}</div>
    ${hint ? `<div class="hint">${hint}</div>` : ''}
  </div>`;
}

export function tiles(items) {
  return `<div class="tiles">${items.filter(Boolean).map(tile).join('')}</div>`;
}

export function chip(text, tone = '') {
  return `<span class="chip ${tone}">${escapeHtml(text)}</span>`;
}

export function kv(pairs) {
  return `<dl class="kv">${pairs
    .filter(Boolean)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v ?? '—'}</dd>`)
    .join('')}</dl>`;
}

/* ------------------------------------------------------------------ meters */

/**
 * Margin bar: how close a planned value sits to its ceiling.
 * Fills proportionally and turns amber/red as the remaining margin shrinks.
 */
export function meter({ label, value, max, units, warnBelow = 500, badBelow = 100 }) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return `<div class="meter"><div class="meter-head"><span class="name">${escapeHtml(label)}</span><span class="amount">—</span></div></div>`;
  }
  const margin = max - value;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const tone = margin < badBelow ? 'bad' : margin < warnBelow ? 'warn' : '';

  return `<div class="meter ${tone}">
    <div class="meter-head">
      <span class="name">${escapeHtml(label)}</span>
      <span class="amount">${fmtWeight(value, units)}</span>
    </div>
    <div class="track"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>
    <div class="foot">
      <span>${t('common.margin')} ${margin < 0 ? '−' : ''}${fmtWeight(Math.abs(margin), units)}</span>
      <span>${t('common.max')} ${fmtWeight(max, units)}</span>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- findings */

/**
 * Extract the right-language string from a bilingual finding field.
 * Findings store both languages as { he: "...", en: "..." } so they update
 * when the language is toggled at runtime.
 */
function getText(field) {
  if (!field) return '';
  if (typeof field === 'string') return field; // backward compat
  // field is { he: "...", en: "..." }
  return field[getLang()] || field.en || '';
}

export function findingsList(findings, { showChapter = false } = {}) {
  if (!findings.length) {
    return `<div class="empty-state good">${escapeHtml(t('sev.none'))}</div>`;
  }
  return `<div class="findings">${findings
    .map(
      (f) => `<button class="finding ${severityClass(f.severity)}" data-action="goto-finding" data-chapter="${f.chapter}" data-id="${f.id}">
        <span class="bar"></span>
        <span class="txt">
          <span class="title">${escapeHtml(getText(f.title))}</span>
          <span class="detail">${escapeHtml(getText(f.detail))}</span>
          ${showChapter ? `<span class="where">${escapeHtml(severityLabel(f.severity))} · ${escapeHtml(t(`nav.${f.chapter}`))}</span>` : ''}
        </span>
      </button>`
    )
    .join('')}</div>`;
}

/** The findings strip a chapter shows at its top. Renders nothing when clean. */
export function chapterFindings(findings, chapter) {
  const mine = findings.filter((f) => f.chapter === chapter);
  if (!mine.length) return '';
  const critical = mine.filter((f) => f.severity === SEVERITY.CRITICAL).length;
  return flushCard({
    title: t('sum.watchItems'),
    badge: chip(`${mine.length}`, critical ? 'red' : 'amber'),
    body: findingsList(mine),
    cls: critical ? 'accent-red' : 'accent-amber'
  });
}

/* ----------------------------------------------------------------- weather */

/** Compass rose showing where the wind is coming from. */
export function windRose(direction, speed, runwayCourse = null) {
  if (!Number.isFinite(direction)) {
    return `<svg class="wind-arrow" viewBox="0 0 48 48"><circle class="dial" cx="24" cy="24" r="20"/></svg>`;
  }
  // The needle points the way the air is travelling (from `direction`).
  const rad = ((direction + 180) * Math.PI) / 180;
  const cx = 24;
  const cy = 24;
  const len = 15;
  const tipX = cx + Math.sin(rad) * len;
  const tipY = cy - Math.cos(rad) * len;
  const backX = cx - Math.sin(rad) * 9;
  const backY = cy + Math.cos(rad) * 9;
  const perp = rad + Math.PI / 2;
  const w = 5;

  const runwayLine = Number.isFinite(runwayCourse)
    ? (() => {
        const r = (runwayCourse * Math.PI) / 180;
        const x1 = cx - Math.sin(r) * 18;
        const y1 = cy + Math.cos(r) * 18;
        const x2 = cx + Math.sin(r) * 18;
        const y2 = cy - Math.cos(r) * 18;
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,176,46,.75)" stroke-width="3" stroke-linecap="round"/>`;
      })()
    : '';

  return `<svg class="wind-arrow" viewBox="0 0 48 48" role="img" aria-label="${direction}° ${speed}kt">
    <circle class="dial" cx="24" cy="24" r="20"/>
    <line class="tick" x1="24" y1="4" x2="24" y2="8"/>
    ${runwayLine}
    <polygon class="needle" points="${tipX.toFixed(1)},${tipY.toFixed(1)} ${(backX + Math.sin(perp) * w).toFixed(1)},${(backY - Math.cos(perp) * w).toFixed(1)} ${(backX - Math.sin(perp) * w).toFixed(1)},${(backY + Math.cos(perp) * w).toFixed(1)}"/>
  </svg>`;
}

/** Decoded METAR: the figures a crew reads first, with raw text underneath. */
export function metarBlock(airport) {
  if (!airport?.metar) {
    return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;
  }
  const m = parseMetar(airport.metar);
  const ceiling = ceilingOf(m);
  const category = airport.metarCategory;

  const visibility = m.cavok
    ? '10+ km'
    : m.visibility?.unlimited
    ? '10+ km'
    : m.visibility?.metres
    ? `${fmtNumber(m.visibility.metres)} m`
    : '—';

  const weatherText = m.weather.map((w) => w.text).filter(Boolean).join(', ');

  return `
    <div style="display:flex;gap:13px;align-items:center;margin-block-end:11px;">
      ${windRose(m.wind?.direction, m.wind?.speed)}
      <div style="min-width:0;flex:1">
        <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-block-end:3px">
          ${category ? `<span class="chip ${categoryClass(category)}">${escapeHtml(t(`wx.category.${category}`, category.toUpperCase()))}</span>` : ''}
          ${m.cavok ? chip('CAVOK', 'green') : ''}
          ${m.trend ? chip(m.trend) : ''}
          ${weatherText ? chip(weatherText, 'amber') : ''}
        </div>
        <div style="font-size:13px;color:var(--dim)">
          ${escapeHtml(t('wx.issued'))} <span class="num">${escapeHtml(airport.metarTime ? fmtZulu(new Date(airport.metarTime)) : '—')}</span>
        </div>
      </div>
    </div>

    ${tiles([
      { label: t('common.wind'), value: escapeHtml(describeWind(m.wind)), size: '' },
      { label: t('common.visibility'), value: visibility },
      { label: t('common.ceiling'), value: ceiling ? fmtFeet(ceiling) : (m.cavok ? 'CAVOK' : '—') },
      { label: t('common.temp'), value: m.temperature === null ? '—' : `${m.temperature}°`, hint: m.dewpoint === null ? '' : `${t('common.dewpoint')} ${m.dewpoint}°` },
      { label: t('common.qnh'), value: m.qnhHpa ? String(m.qnhHpa) : '—', hint: m.qnhInHg ? `${m.qnhInHg.toFixed(2)} inHg` : '' }
    ])}

    ${m.wind?.varyFrom ? `<div style="font-size:12px;color:var(--dim);margin-block-start:9px">${escapeHtml(t('wx.variable'))} <span class="num">${m.wind.varyFrom}° – ${m.wind.varyTo}°</span></div>` : ''}

    <div class="raw-wx" style="margin-block-start:11px">${escapeHtml(airport.metar)}</div>
  `;
}

/**
 * TAF split into groups, with the group covering `reference` highlighted so the
 * crew sees the forecast that applies to their time without reading the rest.
 */
export function tafBlock(airport, reference) {
  if (!airport?.taf) {
    return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;
  }
  const issued = airport.tafTime ? new Date(airport.tafTime) : null;
  const taf = parseTaf(airport.taf, issued || new Date());

  return `<div class="taf-groups">${taf.groups
    .map((g) => {
      const covers = reference ? groupCovers(g, reference) : false;
      const kindClass = g.probability ? 'prob' : g.kind === 'TEMPO' || g.kind === 'INTER' ? 'tempo' : '';
      const when =
        g.from && g.to
          ? `${fmtZuluDate(g.from)} → ${fmtZuluDate(g.to)}`
          : g.from
          ? `${t('notam.effective')} ${fmtZuluDate(g.from)}`
          : '';
      return `<div class="taf-group ${kindClass} ${covers ? 'covers' : ''}">
        ${when ? `<span class="when">${escapeHtml(when)}${covers ? ` · ${escapeHtml(t('des.expectedAtEta'))}` : ''}</span>` : ''}
        ${escapeHtml(g.text)}
      </div>`;
    })
    .join('')}</div>`;
}

/** Enroute SIGMETs, if any. A clean "none" state is itself useful information. */
export function sigmetCard(model) {
  const items = model.sigmets || [];
  return flushCard({
    title: t('wx.sigmet'),
    badge: items.length ? chip(`${items.length}`, 'amber') : chip('0', 'green'),
    body: items.length
      ? `<div class="rows">${items
          .map(
            (s) => `<div class="row" style="align-items:flex-start;flex-direction:column;gap:5px">
              ${s.fir ? chip(s.fir, 'blue') : ''}
              <div class="raw-wx">${escapeHtml(s.text)}</div>
            </div>`
          )
          .join('')}</div>`
      : `<div class="empty-state good">${escapeHtml(t('wx.sigmetEmpty'))}</div>`,
    cls: items.length ? 'accent-amber' : ''
  });
}

export function atisBlock(airport) {
  if (!airport?.atis?.length) return '';
  // Multiple networks may publish; the last entry is the freshest.
  const latest = airport.atis[airport.atis.length - 1];
  return collapsible({
    title: `${t('wx.atis')}${latest.letter ? ` — ${latest.letter}` : ''}`,
    badge: latest.source ? chip(latest.source) : '',
    body: `<div class="raw-wx">${escapeHtml(latest.text)}</div>`
  });
}

/* ------------------------------------------------------------------ NOTAMs */

/** Filter state per airport, kept across re-renders of a chapter. */
export const notamFilters = new Map();

export function getNotamFilter(icao) {
  if (!notamFilters.has(icao)) {
    notamFilters.set(icao, { activeOnly: true, hideObstacles: false });
  }
  return notamFilters.get(icao);
}

/**
 * Sorts NOTAMs by severity, marks the ones touching the planned runway, and
 * applies the current filter. Returns the list markup only, so a filter change
 * can swap it without rebuilding the card.
 */
export function notamListMarkup(airport, window) {
  const filter = getNotamFilter(airport.icao);

  const ranked = airport.notams
    .map((n) => ({ notam: n, severity: notamSeverity(n, airport.plannedRunway) }))
    .filter(({ notam }) => {
      if (filter.hideObstacles && notam.isObstacle) return false;
      if (filter.activeOnly && !notamActiveDuring(notam, window?.start, window?.end)) return false;
      return true;
    })
    .sort((a, b) => b.severity - a.severity);

  if (!ranked.length) {
    return `<div class="empty-state">${escapeHtml(t('notam.empty'))}</div>`;
  }

  return ranked
    .map(({ notam, severity }) => {
      const body = notam.html ? sanitizeNotamHtml(notam.html) : escapeHtml(notam.text || notam.raw || '');
      const from = notam.effective ? fmtZuluDate(new Date(notam.effective)) : null;
      const to = notam.expires ? fmtZuluDate(new Date(notam.expires)) : null;

      return `<article class="notam sev-${severity}">
        <div class="top">
          <span class="nid">${escapeHtml(notam.id || '')}</span>
          ${notam.subject ? chip(notam.subject, severity === 3 ? 'red' : severity === 2 ? 'amber' : '') : ''}
          ${notam.status ? chip(notam.status) : ''}
          ${notam.isObstacle ? chip('OBST') : ''}
        </div>
        <div class="text">${body}</div>
        ${notam.schedule ? `<div class="schedule">${escapeHtml(notam.schedule)}</div>` : ''}
        ${from || to ? `<div class="when">${from ? `${t('notam.effective')} ${from}` : ''}${to ? `  ·  ${t('notam.expires')} ${to}${notam.expiryEstimated ? ` (${t('notam.estimated')})` : ''}` : ''}</div>` : ''}
      </article>`;
    })
    .join('');
}

export function notamCard(airport, window) {
  const filter = getNotamFilter(airport.icao);
  const criticalCount = airport.notams.filter((n) => notamSeverity(n, airport.plannedRunway) === 3).length;

  const tools = `<div class="notam-tools">
    <label class="toggle">
      <input type="checkbox" data-action="notam-filter" data-key="activeOnly" data-icao="${airport.icao}" ${filter.activeOnly ? 'checked' : ''}>
      ${escapeHtml(t('notam.activeOnly'))}
    </label>
    <label class="toggle">
      <input type="checkbox" data-action="notam-filter" data-key="hideObstacles" data-icao="${airport.icao}" ${filter.hideObstacles ? 'checked' : ''}>
      ${escapeHtml(t('notam.hideObstacles'))}
    </label>
  </div>`;

  return flushCard({
    title: `${t('notam.title')} — ${airport.icao}`,
    badge: `${criticalCount ? chip(`${criticalCount} ${t('sev.critical')}`, 'red') : ''}${chip(`${airport.notams.length} ${t('notam.count')}`)}`,
    body: `${tools}<div data-notam-list data-icao="${airport.icao}">${notamListMarkup(airport, window)}</div>`,
    cls: criticalCount ? 'accent-red' : ''
  });
}

/**
 * Landing performance for the planned runway: LDA, flap, ILS, the runway
 * drawn to scale, wind components and the weight-vs-limit meter. Shared by
 * the arrival chapter (full detail) and the descent chapter (reviewed ahead
 * of top of descent, before workload picks up).
 */
export function landingPerformanceBody(model) {
  const tlr = model.tlr.landing;
  if (!tlr) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const runway = tlr.runways.find((r) => r.identifier === tlr.plannedRunway) || tlr.runways[0];
  if (!runway) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const maxWeight = runway.maxWeightDry ?? model.weights.maxLdw;
  const isTailwind = Number.isFinite(runway.headwind) && runway.headwind < 0;

  return `
    ${tiles([
      { label: t('common.runway'), value: escapeHtml(runway.identifier), size: 'huge', tone: 'info' },
      { label: t('arr.lda'), value: fmtNumber(runway.lda), unit: 'ft', size: 'big' },
      { label: t('to.flap'), value: tlr.flap || runway.flap || '—', size: 'big' },
      { label: 'ILS', value: runway.ils || '—' }
    ])}

    <div style="padding:13px">
      ${runwayBar(runway, { showStop: false })}
    </div>

    <div style="padding:0 13px">
      ${tiles([
        {
          label: isTailwind ? t('to.tailwind') : t('to.headwind'),
          value: Number.isFinite(runway.headwind) ? String(Math.abs(runway.headwind)) : '—',
          unit: 'kt',
          tone: isTailwind ? 'bad' : 'good'
        },
        {
          label: t('to.crosswind'),
          value: Number.isFinite(runway.crosswind) ? String(runway.crosswind) : '—',
          unit: 'kt',
          tone: !Number.isFinite(runway.crosswind) ? '' : runway.crosswind >= 25 ? 'bad' : runway.crosswind >= 15 ? 'warn' : 'good'
        },
        { label: t('arr.gradient'), value: runway.gradient === null ? '—' : `${runway.gradient}%` },
        { label: t('common.temp'), value: tlr.temperature === null ? '—' : `${tlr.temperature}°C` }
      ])}
    </div>

    <div style="padding:13px">
      ${meter({ label: t('arr.ldw'), value: tlr.plannedWeight ?? model.weights.estLdw, max: maxWeight, units: model.units })}
      ${kv([
        [t('arr.maxDry'), runway.maxWeightDry ? fmtWeight(runway.maxWeightDry, model.units) : '—'],
        [t('arr.maxWet'), runway.maxWeightWet ? fmtWeight(runway.maxWeightWet, model.units) : '—'],
        [t('to.surface'), tlr.surface || '—']
      ])}
    </div>
  `;
}

/* ------------------------------------------------------------------ runway */

/**
 * Scaled runway strip for takeoff: available length, accelerate-stop distance,
 * the decision point and the remaining margin. Reading "how much room is left"
 * off a picture is faster than comparing four numbers.
 */
export function runwayBar(runway, { showStop = true } = {}) {
  const available = runway.asda || runway.tora || runway.length;
  if (!available) return '';

  const reject = showStop ? runway.distanceReject : null;
  const decide = showStop ? runway.distanceDecide : null;
  const scale = Math.max(available, reject || 0);

  const W = 640;
  const H = 74;
  const padX = 8;
  const barY = 22;
  const barH = 26;
  const usable = W - padX * 2;
  const px = (v) => padX + (v / scale) * usable;

  const marginOk = Number.isFinite(runway.distanceMargin) && runway.distanceMargin >= 300;

  return `<div class="runway-bar"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
    <rect class="rw-surface" x="${padX}" y="${barY}" width="${usable}" height="${barH}" rx="2"/>
    <line class="rw-centerline" x1="${padX + 12}" y1="${barY + barH / 2}" x2="${padX + usable - 12}" y2="${barY + barH / 2}"/>

    ${
      reject
        ? `<rect class="${marginOk ? 'rw-margin-ok' : 'rw-margin-bad'}" x="${px(reject)}" y="${barY}" width="${Math.max(0, px(available) - px(reject))}" height="${barH}"/>
           <rect class="rw-used" x="${padX}" y="${barY}" width="${px(reject) - padX}" height="${barH}"/>
           <line class="rw-mark" x1="${px(reject)}" y1="${barY - 5}" x2="${px(reject)}" y2="${barY + barH + 5}"/>`
        : ''
    }
    ${
      decide
        ? `<line class="rw-mark" x1="${px(decide)}" y1="${barY - 5}" x2="${px(decide)}" y2="${barY + barH + 5}" stroke="var(--amber)"/>
           <text class="rw-text-em" x="${px(decide)}" y="${barY - 9}" text-anchor="middle" fill="var(--amber)">V1</text>`
        : ''
    }

    <text class="rw-text-em" x="${padX}" y="${barY - 9}" text-anchor="start">${escapeHtml(runway.identifier)}</text>
    <text class="rw-text" x="${padX + usable}" y="${barY - 9}" text-anchor="end">${fmtNumber(available)} ft</text>
    ${
      reject
        ? `<text class="rw-text" x="${px(reject)}" y="${barY + barH + 17}" text-anchor="middle">${fmtNumber(reject)} ft</text>
           <text class="rw-text" x="${(px(reject) + px(available)) / 2}" y="${barY + barH + 17}" text-anchor="middle" fill="${marginOk ? 'var(--green)' : 'var(--red)'}">+${fmtNumber(runway.distanceMargin ?? available - reject)} ft</text>`
        : ''
    }
  </svg></div>`;
}

/** Comparison table across every runway SimBrief evaluated. */
export function runwayTable(tlr, { landing = false } = {}) {
  if (!tlr?.runways?.length) return '';
  const headers = landing
    ? [t('common.runway'), 'LDA', t('to.headwind'), t('to.crosswind'), t('arr.maxDry'), t('arr.gradient'), 'ILS']
    : [t('common.runway'), 'TORA', 'TODA', 'ASDA', t('to.headwind'), t('to.crosswind'), t('common.max'), t('to.limitedBy')];

  const rows = tlr.runways
    .map((r) => {
      const planned = r.identifier === tlr.plannedRunway;
      const cells = landing
        ? [
            r.identifier,
            fmtNumber(r.lda),
            signedWind(r.headwind),
            r.crosswind ?? '—',
            r.maxWeightDry ? fmtNumber(r.maxWeightDry) : '—',
            r.gradient ?? '—',
            r.ils || '—'
          ]
        : [
            r.identifier,
            fmtNumber(r.tora),
            fmtNumber(r.toda),
            fmtNumber(r.asda),
            signedWind(r.headwind),
            r.crosswind ?? '—',
            r.maxWeight ? fmtNumber(r.maxWeight) : '—',
            r.limitCode || '—'
          ];
      return `<tr class="${planned ? 'planned' : ''}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    })
    .join('');

  return `<div class="table-scroll"><table class="rw-table">
    <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/** Negative headwind is a tailwind; show it with the sign that reads right. */
function signedWind(headwind) {
  if (!Number.isFinite(headwind)) return '—';
  return headwind < 0 ? `−${Math.abs(headwind)}` : `+${headwind}`;
}

/* --------------------------------------------------------------- fix lists */

export function fixList(fixes, { showSpeed = true } = {}) {
  if (!fixes.length) return `<div class="empty-state">${escapeHtml(t('common.none'))}</div>`;
  return `<div class="fix-list">${fixes
    .map(
      (f) => `<div class="fix-row">
        <span><span class="ident">${escapeHtml(f.ident)}</span>${f.via ? `<span class="via">${escapeHtml(f.via)}</span>` : ''}</span>
        <span class="alt">${f.altitude ? fmtFeet(f.altitude) : '—'}</span>
        ${showSpeed ? `<span class="spd">${f.ias ? `${f.ias} kt` : ''}</span>` : '<span></span>'}
      </div>`
    )
    .join('')}</div>`;
}

/* ------------------------------------------------------------------ header */

export function airportIdentity(airport) {
  return tiles([
    { label: t('common.runway'), value: escapeHtml(airport.plannedRunway || '—'), tone: 'info', size: 'big' },
    { label: t('common.elevation'), value: fmtFeet(airport.elevation) },
    { label: t('common.transAlt'), value: airport.transAlt ? fmtFeet(airport.transAlt) : '—', tone: 'warn' },
    { label: t('common.transLevel'), value: airport.transLevel ? `FL${Math.round(airport.transLevel / 100)}` : '—', tone: 'warn' }
  ]);
}

export function chapterHeading(title, subtitle) {
  return `<div class="chapter-title">
    <h1>${escapeHtml(title)}</h1>
    ${subtitle ? `<span class="sub">${escapeHtml(subtitle)}</span>` : ''}
  </div>`;
}

export { escapeHtml, fmtNumber, fmtFeet, fmtWeight, fmtZulu, fmtZuluDate, decodeSurface, getLang };
