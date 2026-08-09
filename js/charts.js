/**
 * The heavy route visualisations, shared by the type-based chapters.
 *
 * Centrepiece is the route weather strip: one horizontal axis of navlog fixes
 * with altitude/terrain, wind component, ISA deviation and shear stacked as
 * bands. Anomalies are flagged on the axis and tapping a point opens the full
 * figures for that fix. This is the answer to "unusual weather at a specific
 * point on the route".
 */

import { t } from './i18n.js';
import {
  escapeHtml,
  fmtNumber,
  fmtFeet,
  fmtWeight,
  fmtDurationShort,
  screenEnrouteNotam,
  notamActiveDuring,
  notamIconName
} from './decode.js';
import { flushCard, chip, icon } from './ui.js';
import { THRESHOLDS } from './analyze.js';

/**
 * Enroute NOTAMs, cut down to something readable.
 *
 * SimBrief ships every NOTAM for every FIR touched — 793 on this route. Almost
 * all are obstacles and lighting, which belong to an airport briefing, not to
 * the cruise. What is left is airspace and activity: restricted areas, military
 * exercises, firing, UAV operations.
 */
export function enrouteNotams(model) {
  const routeFirs = new Set([
    ...model.route.firs,
    ...model.navlog.map((f) => f.fir).filter(Boolean)
  ]);

  const window = {
    start: model.times.estOut || model.times.schedOut,
    end: model.times.estIn || model.times.schedIn
  };

  const relevant = model.enrouteNotams
    .filter((n) => !n.location || routeFirs.has(n.location))
    .filter((n) => notamActiveDuring(n, window.start, window.end))
    .map((n) => ({ notam: n, screen: screenEnrouteNotam(n) }))
    .filter(({ screen }) => screen.keep)
    .sort((a, b) => b.screen.severity - a.screen.severity);

  const live = relevant.filter(({ screen }) => screen.severity === 2).length;

  if (!relevant.length) {
    return { kept: 0, total: model.enrouteNotams.length, live: 0, body: `<div class="empty-state">${escapeHtml(t('notam.empty'))}</div>` };
  }

  const body = relevant
    .slice(0, 40)
    .map(
      ({ notam, screen }) => `<article class="notam sev-${screen.severity}">
        <div class="top">
          <span class="notam-icon">${icon(notamIconName(notam), { size: 15 })}</span>
          <span class="nid">${escapeHtml(notam.location || '')} · ${escapeHtml(notam.id || '')}</span>
          ${screen.subject ? chip(screen.subject, screen.severity === 2 ? 'amber' : '') : ''}
          ${screen.condition ? chip(screen.condition) : ''}
        </div>
        <div class="text">${escapeHtml(notamSummary(notam))}</div>
      </article>`
    )
    .join('');

  return {
    kept: relevant.length,
    total: model.enrouteNotams.length,
    live,
    body: `<div class="img-note" style="padding:11px 15px">${escapeHtml(t('notam.enrouteNote'))}</div>${body}`
  };
}

/** The E) field carries the message; the rest of the raw NOTAM is envelope. */
function notamSummary(notam) {
  const text = notam.text || notam.raw || '';
  const body = text.match(/\bE\)\s*([\s\S]*?)(?:\n\s*[FG]\)|$)/);
  return (body ? body[1] : text).trim().replace(/\s+/g, ' ').slice(0, 320);
}

/* ------------------------------------------------------------ weather strip */

/** Fixes worth flagging, and why. Shared by the strip and the detail card. */
function anomaliesFor(fix, previous) {
  const reasons = [];
  if (Number.isFinite(fix.shear) && fix.shear >= THRESHOLDS.shear) {
    reasons.push({ kind: 'shear', critical: fix.shear >= THRESHOLDS.shear * 1.5 });
  }
  if (Number.isFinite(fix.isaDev) && Math.abs(fix.isaDev) >= THRESHOLDS.isaDeviation) {
    reasons.push({ kind: 'isa', critical: false });
  }
  if (
    previous &&
    Number.isFinite(fix.windComponent) &&
    Number.isFinite(previous.windComponent) &&
    Math.abs(fix.windComponent - previous.windComponent) >= THRESHOLDS.windComponentJump
  ) {
    reasons.push({ kind: 'wind', critical: false });
  }
  return reasons;
}

export function defaultFix(model) {
  // Open on the first flagged fix, so the interesting point is already shown.
  for (let i = 0; i < model.navlog.length; i += 1) {
    if (anomaliesFor(model.navlog[i], model.navlog[i - 1]).length) return model.navlog[i];
  }
  return model.topOfClimb || model.navlog[0];
}

export function weatherStrip(model) {
  const fixes = model.navlog;
  if (!fixes.length) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const padL = 46;
  const padR = 14;
  // Size the spacing so a typical route fits the column without scrolling,
  // but never squeeze below the point where the fix labels stop being readable.
  const step = Math.max(26, Math.min(40, Math.floor(940 / fixes.length)));
  const W = padL + fixes.length * step + padR;

  // Band geometry.
  const flagY = 6;
  const A = { top: 22, h: 92 }; // altitude + terrain
  const B = { top: 132, h: 58 }; // wind component
  const C = { top: 206, h: 44 }; // ISA deviation
  const D = { top: 266, h: 34 }; // shear
  const labelY = D.top + D.h + 26;
  const H = labelY + 12;

  const x = (i) => padL + i * step + step / 2;

  const maxAlt = Math.max(40000, ...fixes.map((f) => f.altitude || 0));
  const maxMora = Math.max(...fixes.map((f) => f.mora || 0), 1);
  const maxWind = Math.max(20, ...fixes.map((f) => Math.abs(f.windComponent || 0)));
  const maxIsa = Math.max(10, ...fixes.map((f) => Math.abs(f.isaDev || 0)));
  const maxShear = Math.max(THRESHOLDS.shear, ...fixes.map((f) => f.shear || 0));

  const yAlt = (v) => A.top + A.h - (Math.max(0, v) / maxAlt) * A.h;
  const yWind = (v) => B.top + B.h / 2 - (v / maxWind) * (B.h / 2);
  const yIsa = (v) => C.top + C.h / 2 - (v / maxIsa) * (C.h / 2);

  const profilePath = fixes.map((f, i) => `${i ? 'L' : 'M'}${x(i)},${yAlt(f.altitude || 0).toFixed(1)}`).join(' ');

  const terrainPath =
    `M${padL},${A.top + A.h} ` +
    fixes.map((f, i) => `L${x(i)},${(A.top + A.h - ((f.mora || 0) / maxAlt) * A.h).toFixed(1)}`).join(' ') +
    ` L${x(fixes.length - 1)},${A.top + A.h} Z`;

  // Wind component filled to the zero line, split so head/tail get their colour.
  const windSegments = fixes
    .map((f, i) => {
      const value = f.windComponent || 0;
      const y0 = yWind(0);
      const y1 = yWind(value);
      const top = Math.min(y0, y1);
      const height = Math.abs(y1 - y0);
      if (height < 0.5) return '';
      // SimBrief reports a positive component as a tailwind.
      return `<rect class="${value >= 0 ? 'tail-area' : 'head-area'}" x="${x(i) - step / 2 + 3}" y="${top.toFixed(1)}" width="${step - 6}" height="${height.toFixed(1)}"/>`;
    })
    .join('');

  const isaPath = fixes.map((f, i) => `${i ? 'L' : 'M'}${x(i)},${yIsa(f.isaDev || 0).toFixed(1)}`).join(' ');

  const shearBars = fixes
    .map((f, i) => {
      const value = f.shear || 0;
      const h = (value / maxShear) * D.h;
      const cls = value >= THRESHOLDS.shear * 1.5 ? 'critical' : value >= THRESHOLDS.shear ? 'hot' : '';
      if (h <= 0) return '';
      return `<rect class="shear-bar ${cls}" x="${x(i) - 5}" y="${(D.top + D.h - h).toFixed(1)}" width="10" height="${h.toFixed(1)}" rx="1"/>`;
    })
    .join('');

  // FIR boundaries.
  const firLines = fixes
    .map((f, i) => {
      if (i === 0 || f.fir === fixes[i - 1].fir) return '';
      const xi = x(i) - step / 2;
      return `<line class="fir-line" x1="${xi}" y1="${A.top}" x2="${xi}" y2="${D.top + D.h}"/>
              <text class="lbl" x="${xi + 3}" y="${A.top + 9}">${escapeHtml(f.fir || '')}</text>`;
    })
    .join('');

  const flags = fixes
    .map((f, i) => {
      const reasons = anomaliesFor(f, fixes[i - 1]);
      if (!reasons.length) return '';
      const critical = reasons.some((r) => r.critical);
      return `<polygon class="flag ${critical ? 'critical' : ''}" points="${x(i)},${flagY} ${x(i) - 5},${flagY + 9} ${x(i) + 5},${flagY + 9}"/>`;
    })
    .join('');

  const labels = fixes
    .map((f, i) => `<text class="lbl-fix" x="${x(i)}" y="${labelY}" text-anchor="end" transform="rotate(-58 ${x(i)} ${labelY})">${escapeHtml(f.ident)}</text>`)
    .join('');

  const selected = defaultFix(model);
  const hits = fixes
    .map(
      (f, i) =>
        `<rect class="hit" data-action="select-fix" data-fix-index="${f.index}" aria-selected="${f.index === selected?.index}" x="${x(i) - step / 2}" y="${A.top}" width="${step}" height="${D.top + D.h - A.top}"/>`
    )
    .join('');

  const bandLabel = (text, y) => `<text class="lbl-band" x="4" y="${y}">${escapeHtml(text)}</text>`;

  return `<div class="wx-strip" data-wx-strip>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeHtml(t('crz.wxStrip'))}">
      ${bandLabel(t('crz.layer.terrain'), A.top + 10)}
      ${bandLabel(t('crz.layer.wind'), B.top + 10)}
      ${bandLabel(t('crz.layer.isa'), C.top + 10)}
      ${bandLabel(t('crz.layer.shear'), D.top + 10)}

      <path class="terrain" d="${terrainPath}"/>
      <path class="profile-line" d="${profilePath}"/>
      <text class="lbl" x="${padL - 4}" y="${yAlt(maxAlt) + 8}" text-anchor="end">FL${Math.round(maxAlt / 100)}</text>
      <text class="lbl" x="${padL - 4}" y="${A.top + A.h}" text-anchor="end">0</text>
      <text class="lbl" x="${W - padR}" y="${A.top + A.h - (maxMora / maxAlt) * A.h - 3}" text-anchor="end">MORA ${fmtNumber(maxMora)}</text>

      ${windSegments}
      <line class="zero-line" x1="${padL}" y1="${yWind(0)}" x2="${W - padR}" y2="${yWind(0)}"/>
      <text class="lbl" x="${padL - 4}" y="${yWind(maxWind) + 8}" text-anchor="end">+${maxWind}</text>
      <text class="lbl" x="${padL - 4}" y="${yWind(-maxWind)}" text-anchor="end">−${maxWind}</text>

      <path class="isa-line" d="${isaPath}"/>
      <line class="zero-line" x1="${padL}" y1="${yIsa(0)}" x2="${W - padR}" y2="${yIsa(0)}"/>
      <text class="lbl" x="${padL - 4}" y="${yIsa(maxIsa) + 8}" text-anchor="end">+${maxIsa}</text>
      <text class="lbl" x="${padL - 4}" y="${yIsa(-maxIsa)}" text-anchor="end">−${maxIsa}</text>

      ${shearBars}
      <line class="axis" x1="${padL}" y1="${D.top + D.h}" x2="${W - padR}" y2="${D.top + D.h}"/>

      ${firLines}
      ${flags}
      ${labels}
      ${hits}
    </svg>
  </div>`;
}

/**
 * Full figures for one fix. Exported so the controller can swap it in when a
 * point on the strip is tapped.
 */
export function buildFixDetail(fix, model) {
  if (!fix) return '';
  const previous = model.navlog[fix.index - 1];
  const reasons = anomaliesFor(fix, previous);

  const cell = (label, value, tone = '') =>
    `<div><div class="k">${escapeHtml(label)}</div><div class="v ${tone}">${value}</div></div>`;

  const shearTone = Number.isFinite(fix.shear) && fix.shear >= THRESHOLDS.shear ? 'hot' : '';
  const isaTone = !Number.isFinite(fix.isaDev)
    ? ''
    : Math.abs(fix.isaDev) >= THRESHOLDS.isaDeviation
    ? 'hot'
    : fix.isaDev < 0
    ? 'cold'
    : '';

  const componentLabel = (fix.windComponent ?? 0) >= 0 ? t('crz.tailwindShort') : t('crz.headwindShort');

  return `<div class="fix-detail">
    <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
      <span class="fix-name">${escapeHtml(fix.ident)}</span>
      ${fix.stage ? chip(fix.stage) : ''}
      ${fix.fir ? chip(fix.fir, 'blue') : ''}
      ${reasons.some((r) => r.kind === 'shear') ? chip(t('crz.layer.shear'), 'amber') : ''}
      ${reasons.some((r) => r.kind === 'isa') ? chip(t('crz.layer.isa'), 'amber') : ''}
      ${reasons.some((r) => r.kind === 'wind') ? chip(t('crz.layer.wind'), 'amber') : ''}
    </div>
    <div class="fix-grid" style="margin-block-start:10px">
      ${cell(t('common.runway') === '' ? 'ALT' : 'ALT', fix.altitude ? fmtFeet(fix.altitude) : '—')}
      ${cell(t('common.wind'), `${fix.windDir ?? '—'}° / ${fix.windSpd ?? '—'} kt`)}
      ${cell(componentLabel, `${Math.abs(fix.windComponent ?? 0)} kt`)}
      ${cell(t('crz.layer.shear'), fix.shear ?? '—', shearTone)}
      ${cell('OAT', fix.oat === null ? '—' : `${fix.oat}°C`)}
      ${cell(t('crz.layer.isa'), fix.isaDev === null ? '—' : `${fix.isaDev > 0 ? '+' : ''}${fix.isaDev}°`, isaTone)}
      ${cell(t('crz.tropopause'), fix.tropopause ? fmtFeet(fix.tropopause) : '—')}
      ${cell('MORA', fix.mora ? fmtFeet(fix.mora) : '—')}
      ${cell('GS', fix.groundspeed ? `${fix.groundspeed} kt` : '—')}
      ${cell(t('common.fuel'), fix.fuelOnBoard ? fmtWeight(fix.fuelOnBoard, model.units) : '—')}
    </div>
  </div>`;
}

/* ------------------------------------------------------------- step ladder */

export function stepLadder(model) {
  const steps = model.flight.stepClimb;
  if (!steps.length) return `<div class="empty-state">${escapeHtml(t('common.none'))}</div>`;

  const maxFl = Math.max(...steps.map((s) => s.flightLevel || 0), 1);
  return `<div class="ladder">${steps
    .map(
      (s) => `<div class="rung">
        <span class="fl">FL${s.flightLevel ?? '—'}</span>
        <span class="bar" style="height:${Math.max(8, ((s.flightLevel || 0) / maxFl) * 74).toFixed(0)}px"></span>
        <span class="name">${escapeHtml(s.ident)}</span>
      </div>`
    )
    .join('')}</div>`;
}

/* ----------------------------------------------------------------- charts */

export function chartsBody(model) {
  const images = model.images;
  const options = [];

  if (images.sigwx) options.push({ label: t('crz.sigwx'), src: images.sigwx });
  images.winds.forEach((w) => options.push({ label: `${t('crz.windsAloft')} FL${Math.round((w.level || 0) / 100)}`, src: w.url }));
  if (images.profile) options.push({ label: t('crz.profile'), src: images.profile });
  if (images.route) options.push({ label: t('crz.routeMap'), src: images.route });

  if (!options.length) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  // Preselect the winds chart nearest the level actually flown for most of the
  // cruise, rather than the initial level the aircraft only holds briefly.
  const cruiseAlt = dominantCruiseAltitude(model) || model.flight.initialAltitude || 34000;
  let initial = 0;
  if (images.winds.length) {
    const nearest = images.winds.reduce((best, w) => {
      const delta = Math.abs((w.level || 0) - cruiseAlt);
      const bestDelta = Math.abs((best.level || 0) - cruiseAlt);
      // Equidistant charts resolve to the higher level for the same reason.
      if (delta < bestDelta) return w;
      if (delta === bestDelta && (w.level || 0) > (best.level || 0)) return w;
      return best;
    });
    const index = options.findIndex((o) => o.src === nearest.url);
    if (index >= 0) initial = index;
  }

  return `<div data-chart-group>
    <div class="chart-tabs">
      ${options
        .map(
          (o, i) =>
            `<button class="chart-tab" data-action="chart-tab" data-src="${escapeHtml(o.src)}" aria-selected="${i === initial}">${escapeHtml(o.label)}</button>`
        )
        .join('')}
    </div>
    <div class="img-wrap">
      <img class="chart-img" data-chart-image src="${escapeHtml(options[initial].src)}" alt="${escapeHtml(options[initial].label)}" loading="lazy">
    </div>
  </div>`;
}

/**
 * The cruise level the flight spends the most legs at. Step climbs often split
 * the cruise evenly between levels, so ties resolve upward — the later, higher
 * level is the one still ahead of the crew when they open the briefing.
 */
export function dominantCruiseAltitude(model) {
  const counts = new Map();
  for (const fix of model.phases.cruise) {
    if (!Number.isFinite(fix.altitude)) continue;
    counts.set(fix.altitude, (counts.get(fix.altitude) || 0) + 1);
  }
  let best = null;
  for (const [altitude, count] of counts) {
    if (!best || count > best.count || (count === best.count && altitude > best.altitude)) {
      best = { altitude, count };
    }
  }
  return best?.altitude ?? null;
}

/* ------------------------------------------------------------- fuel curve */

export function fuelCurve(model) {
  const fixes = model.navlog.filter((f) => Number.isFinite(f.fuelOnBoard) && Number.isFinite(f.fuelMinOnBoard));
  if (fixes.length < 2) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const W = 640;
  const H = 150;
  const padL = 8;
  const padR = 8;
  const top = 12;
  const bottom = H - 26;

  const maxFuel = Math.max(...fixes.map((f) => f.fuelOnBoard));
  const x = (i) => padL + (i / (fixes.length - 1)) * (W - padL - padR);
  const y = (v) => bottom - (v / maxFuel) * (bottom - top);

  const planned = fixes.map((f, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(f.fuelOnBoard).toFixed(1)}`).join(' ');
  const minimum = fixes.map((f, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(f.fuelMinOnBoard).toFixed(1)}`).join(' ');
  const band =
    `M${x(0).toFixed(1)},${y(fixes[0].fuelOnBoard).toFixed(1)} ` +
    fixes.map((f, i) => `L${x(i).toFixed(1)},${y(f.fuelOnBoard).toFixed(1)}`).join(' ') +
    ` ` +
    fixes
      .map((f, i) => `L${x(fixes.length - 1 - i).toFixed(1)},${y(fixes[fixes.length - 1 - i].fuelMinOnBoard).toFixed(1)}`)
      .join(' ') +
    ' Z';

  const tightest = model.fuelTightest;
  const tightestIndex = tightest ? fixes.findIndex((f) => f.index === tightest.fix.index) : -1;

  return `
    <div style="padding:11px 13px 0">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
        <path d="${band}" fill="rgba(58,212,138,.15)"/>
        <path d="${planned}" fill="none" stroke="var(--blue)" stroke-width="2"/>
        <path d="${minimum}" fill="none" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="5 4"/>
        ${
          tightestIndex >= 0
            ? `<line x1="${x(tightestIndex).toFixed(1)}" y1="${top}" x2="${x(tightestIndex).toFixed(1)}" y2="${bottom}" stroke="var(--amber)" stroke-width="1" stroke-dasharray="3 3"/>
               <circle cx="${x(tightestIndex).toFixed(1)}" cy="${y(fixes[tightestIndex].fuelOnBoard).toFixed(1)}" r="4" fill="var(--amber)"/>
               <text x="${x(tightestIndex).toFixed(1)}" y="${bottom + 16}" text-anchor="middle" fill="var(--amber)" font-family="var(--mono)" font-size="10">${escapeHtml(fixes[tightestIndex].ident)}</text>`
            : ''
        }
      </svg>
    </div>
    <div style="display:flex;gap:14px;padding:8px 13px 11px;font-size:11px;color:var(--dim);flex-wrap:wrap">
      <span><span style="display:inline-block;width:14px;height:2px;background:var(--blue);vertical-align:middle"></span> ${escapeHtml(t('crz.fuelOnBoard'))}</span>
      <span><span style="display:inline-block;width:14px;height:2px;background:var(--red);vertical-align:middle"></span> ${escapeHtml(t('crz.fuelMin'))}</span>
    </div>
    ${
      tightest
        ? `<div class="row" style="background:var(--panel-2)">
             <span class="grow">${escapeHtml(t('crz.tightest'))} · <span class="ltr">${escapeHtml(tightest.fix.ident)}</span></span>
             <span class="val" style="color:${tightest.margin < 500 ? 'var(--amber)' : 'var(--green)'}">${fmtWeight(tightest.margin, model.units)}</span>
           </div>`
        : ''
    }
  `;
}

/* ---------------------------------------------------------------- impacts */

export function impactsTable(model) {
  const rows = [
    ['−6000 ft', model.impacts.minus6000],
    ['−4000 ft', model.impacts.minus4000],
    ['−2000 ft', model.impacts.minus2000],
    ['+2000 ft', model.impacts.plus2000],
    ['+4000 ft', model.impacts.plus4000],
    ['+6000 ft', model.impacts.plus6000],
    [`CI ↑`, model.impacts.higherCi],
    [`CI ↓`, model.impacts.lowerCi],
    [`ZFW +1000`, model.impacts.zfwPlus1000],
    [`ZFW −1000`, model.impacts.zfwMinus1000]
  ].filter(([, impact]) => impact && (impact.burnDifference !== null || impact.timeDifference !== null));

  if (!rows.length) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const cell = (value, unit) => {
    if (!Number.isFinite(value)) return '<td>—</td>';
    const tone = value > 0 ? 'var(--red)' : value < 0 ? 'var(--green)' : 'var(--dim)';
    const sign = value > 0 ? '+' : value < 0 ? '−' : '';
    return `<td style="color:${tone}">${sign}${fmtNumber(Math.abs(value))}${unit}</td>`;
  };

  return `<div class="table-scroll"><table class="rw-table">
    <thead><tr>
      <th>${escapeHtml(t('crz.scenario'))}</th>
      <th>${escapeHtml(t('crz.fuelDelta'))}</th>
      <th>${escapeHtml(t('crz.timeDelta'))}</th>
      <th>FL</th>
    </tr></thead>
    <tbody>${rows
      .map(
        ([label, impact]) => `<tr>
          <td>${escapeHtml(label)}</td>
          ${cell(impact.burnDifference, model.units === 'lbs' ? ' lb' : ' kg')}
          <td style="color:${(impact.timeDifference || 0) > 0 ? 'var(--red)' : (impact.timeDifference || 0) < 0 ? 'var(--green)' : 'var(--dim)'}">${
            Number.isFinite(impact.timeDifference) ? fmtDurationShort(impact.timeDifference) : '—'
          }</td>
          <td>${impact.initialFl ?? '—'}</td>
        </tr>`
      )
      .join('')}</tbody>
  </table></div>`;
}

/* ------------------------------------------------------------------ facts */

export function cruiseFactsBody(model) {
  const f = model.flight;
  const avg = f.avgWindComponent;

  const pairs = [
    [t('to.initialAlt'), f.initialAltitude ? `FL${Math.round(f.initialAltitude / 100)}` : '—'],
    ['MACH', f.cruiseMach || '—'],
    ['TAS', f.cruiseTas ? `${f.cruiseTas} kt` : '—'],
    ['CI', f.costIndex ?? '—'],
    [
      t('crz.avgWind'),
      Number.isFinite(avg)
        ? `<span class="${avg >= 0 ? 'good' : 'bad'}">${avg >= 0 ? '+' : '−'}${Math.abs(avg)} kt</span>`
        : '—'
    ],
    [t('crz.tropopause'), f.avgTropopause ? fmtFeet(f.avgTropopause) : '—'],
    [t('crz.layer.isa'), f.avgTempDev === null ? '—' : `${f.avgTempDev > 0 ? '+' : ''}${f.avgTempDev}°C`],
    [t('crz.profile'), f.cruiseProfile || '—']
  ];

  return `<div class="sect-fields">${pairs
    .map(
      ([label, value]) => `<div class="sect-field">
        <span class="k">${escapeHtml(label)}</span>
        <span class="v ltr">${value}</span>
      </div>`
    )
    .join('')}</div>`;
}

