/**
 * Chapter 6 — Summary.
 * The last screen before the flight: everything flagged, plus the numbers.
 */

import { t } from '../i18n.js';
import {
  escapeHtml,
  fmtNumber,
  fmtWeight,
  fmtFeet,
  fmtDuration,
  fmtZulu,
  categoryClass,
  notamSeverity,
  notamActiveDuring,
  notamIconName,
  sanitizeNotamHtml,
  parseMetar,
  describeWind,
  ceilingOf
} from '../decode.js';
import {
  card,
  flushCard,
  tiles,
  chip,
  icon,
  categoryDot,
  chapterHeading,
  findingsList,
  windRose
} from '../ui.js';
import { SEVERITY } from '../analyze.js';

export default function renderSummary({ model, findings }) {
  const critical = findings.filter((f) => f.severity === SEVERITY.CRITICAL).length;

  return `
    ${chapterHeading(t('sum.title'), `${model.flight.callsign} · ${model.origin?.icao} → ${model.destination?.icao}`)}

    <div class="grid">
      <div class="col-12">
        ${flushCard({
          title: t('sum.watchItems'),
          hint: t('sum.watchHint'),
          badge: findings.length ? chip(`${findings.length}`, critical ? 'red' : 'amber') : chip('0', 'green'),
          body: findings.length
            ? findingsList(findings, { showChapter: true })
            : `<div class="empty-state good">${escapeHtml(t('sum.clean'))}</div>`,
          cls: critical ? 'accent-red' : ''
        })}
      </div>

      <div class="col-12">
        ${flushCard({ title: t('sum.numbers'), body: numbersBody(model) })}
      </div>

      <div class="col-6">
        ${flushCard({ title: t('sum.wxLine'), body: weatherLines(model) })}
      </div>

      <div class="col-6">
        ${flushCard({ title: t('sum.tightest'), body: tightestBody(model) })}
      </div>

      <div class="col-12">
        ${flushCard({ title: t('sum.topNotams'), body: topNotams(model) })}
      </div>

      <div class="col-12" style="text-align:center;padding-block:10px">
        <button class="tool-btn" onclick="window.print()">${escapeHtml(t('sum.print'))}</button>
      </div>
    </div>
  `;
}

function numbersBody(model) {
  const units = model.units === 'lbs' ? 'lb' : 'kg';
  return tiles([
    { label: t('sum.blockTime'), value: fmtDuration(model.times.estBlock), size: 'big' },
    { label: t('sum.blockFuel'), value: fmtNumber(model.fuel.planRamp), unit: units, size: 'big' },
    { label: t('dep.tow'), value: fmtNumber(model.weights.estTow), unit: units },
    { label: t('arr.ldw'), value: fmtNumber(model.weights.estLdw), unit: units },
    { label: t('dep.pax'), value: fmtNumber(model.weights.paxCount) },
    { label: t('common.distance'), value: fmtNumber(model.route.distance), unit: 'nm' },
    { label: t('to.initialAlt'), value: model.flight.initialAltitude ? `FL${Math.round(model.flight.initialAltitude / 100)}` : '—' },
    { label: t('header.etd'), value: escapeHtml(fmtZulu(model.times.estOff)) }
  ]);
}

/** One row per airport: wind rose, category, and the decoded figures at a glance. */
function weatherLines(model) {
  const entries = [
    { airport: model.origin, role: t('nav.departure') },
    { airport: model.destination, role: t('nav.arrival') },
    ...model.alternates.map((a) => ({ airport: a, role: t('arr.alternate') }))
  ].filter((e) => e.airport);

  return `<div class="rows">${entries
    .map(({ airport, role }) => {
      const m = airport.metar ? parseMetar(airport.metar) : null;
      const ceiling = m ? ceilingOf(m) : null;
      const visibility = m?.cavok
        ? '10+ km'
        : m?.visibility?.unlimited
        ? '10+ km'
        : m?.visibility?.metres
        ? `${fmtNumber(m.visibility.metres)} m`
        : '—';

      return `<div class="row" style="align-items:center;gap:11px">
        ${windRose(m?.wind?.direction, m?.wind?.speed)}
        <span style="min-width:96px;display:flex;align-items:center;gap:6px">
          ${categoryDot(airport.metarCategory)}
          <span>
            <span class="ltr" style="font-weight:700">${escapeHtml(airport.icao)}</span>
            <span style="display:block;font-size:10.5px;color:var(--dimmer)">${escapeHtml(role)}</span>
          </span>
        </span>
        <span class="grow" style="display:flex;gap:11px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--dim)">
          ${airport.metarCategory ? `<span class="chip ${categoryClass(airport.metarCategory)}">${escapeHtml(airport.metarCategory.toUpperCase())}</span>` : ''}
          <span class="ltr">${escapeHtml(m ? describeWind(m.wind) : '—')}</span>
          <span>${escapeHtml(visibility)}</span>
          <span>${ceiling ? fmtFeet(ceiling) : m?.cavok ? 'CAVOK' : '—'}</span>
        </span>
      </div>`;
    })
    .join('')}</div>`;
}

/** The single closest-to-limit figure in the plan, stated plainly. */
function tightestBody(model) {
  const units = model.units;
  const candidates = [
    { label: t('dep.zfw'), margin: safeMargin(model.weights.maxZfw, model.weights.estZfw) },
    { label: t('dep.tow'), margin: safeMargin(model.weights.maxTow, model.weights.estTow) },
    { label: t('arr.ldw'), margin: safeMargin(model.weights.maxLdw, model.weights.estLdw) }
  ].filter((c) => c.margin !== null);

  if (!candidates.length) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const tightest = candidates.reduce((best, c) => (c.margin < best.margin ? c : best));
  const tone = tightest.margin < 100 ? 'bad' : tightest.margin < 500 ? 'warn' : 'good';

  return `
    ${tiles([
      { label: tightest.label, value: fmtNumber(tightest.margin), unit: units === 'lbs' ? 'lb' : 'kg', size: 'huge', tone, hint: t('common.margin') }
    ])}
    <div class="rows">
      ${candidates
        .map(
          (c) => `<div class="row">
            <span class="grow">${escapeHtml(c.label)}</span>
            <span class="val" style="color:${c.margin < 100 ? 'var(--red)' : c.margin < 500 ? 'var(--amber)' : 'var(--dim)'}">${fmtWeight(c.margin, units)}</span>
          </div>`
        )
        .join('')}
      ${
        model.fuelTightest
          ? `<div class="row">
               <span class="grow">${escapeHtml(t('crz.tightest'))} · <span class="ltr">${escapeHtml(model.fuelTightest.fix.ident)}</span></span>
               <span class="val">${fmtWeight(model.fuelTightest.margin, units)}</span>
             </div>`
          : ''
      }
    </div>
  `;
}

function safeMargin(max, estimate) {
  return Number.isFinite(max) && Number.isFinite(estimate) ? max - estimate : null;
}

/** Highest-ranked NOTAMs from every airport, merged into one short list. */
function topNotams(model) {
  const window = {
    start: model.times.estOut || model.times.schedOut,
    end: model.times.estIn || model.times.schedIn
  };

  const all = [model.origin, model.destination, ...model.alternates]
    .filter(Boolean)
    .flatMap((airport) =>
      airport.notams
        .filter((n) => notamActiveDuring(n, window.start, window.end))
        .map((n) => ({ notam: n, airport, severity: notamSeverity(n, airport.plannedRunway) }))
    )
    .filter((entry) => entry.severity >= SEVERITY.WARNING)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 5);

  if (!all.length) return `<div class="empty-state good">${escapeHtml(t('sev.none'))}</div>`;

  return all
    .map(
      ({ notam, airport, severity }) => `<article class="notam sev-${severity}">
        <div class="top">
          <span class="notam-icon">${icon(notamIconName(notam), { size: 15 })}</span>
          <span class="nid">${escapeHtml(airport.icao)} · ${escapeHtml(notam.id || '')}</span>
          ${notam.subject ? chip(notam.subject, severity === 3 ? 'red' : 'amber') : ''}
          ${notam.status ? chip(notam.status) : ''}
        </div>
        <div class="text">${notam.html ? sanitizeNotamHtml(notam.html) : escapeHtml(notam.text || '')}</div>
        ${notam.schedule ? `<div class="schedule">${escapeHtml(notam.schedule)}</div>` : ''}
      </article>`
    )
    .join('');
}
