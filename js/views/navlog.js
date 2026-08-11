/**
 * Navlog.
 *
 * The route flown as a table of fixes, the vertical plan around it, and a
 * fuel check the crew fills in as the flight goes: what the OFP predicted at
 * each point against what the gauges actually read.
 */

import { t } from '../i18n.js';
import { escapeHtml, fmtNumber, fmtWeight, fmtDuration, fmtZulu } from '../decode.js';
import { section, chip, icon } from '../ui.js';
import { stepLadder, cruiseFactsBody } from '../charts.js';
import { getActuals, summarise, classify } from '../fuellog.js';
import { currentLeg, fixEta, fuelCheckpoints } from '../timeline.js';

export default function renderNavlog({ model, timeline }) {
  const actuals = getActuals(model);
  const leg = currentLeg(model, timeline);

  return `
    <div class="cover">
      ${section(t('crz.title'), 'wind', cruiseFactsBody(model), { action: etopsFlag(model) })}
      ${section(t('crz.stepClimb'), 'aircraft', stepLadder(model))}
      ${section(t('nl.fuelCheck'), 'clock', fuelCheckBody(model, actuals, timeline, leg), {
        action: `<span data-fuel-flag>${summaryFlag(model, actuals)}</span>
                 <button class="notam-btn" data-action="clear-fuel-log" title="${escapeHtml(t('fuel.clearLog'))}" aria-label="${escapeHtml(t('fuel.clearLog'))}">${icon('obstacle', { size: 16 })}</button>`
      })}
      ${section(t('nav.navlog'), 'routeSwap', fixTable(model), {
        action: `<span class="sect-flag">${model.navlog.length} ${escapeHtml(t('nl.fixes'))}</span>`
      })}
      ${section(t('crz.firs'), 'airspace', firsBody(model))}
    </div>
  `;
}

function etopsFlag(model) {
  return model.flight.isEtops
    ? `<span class="sect-flag warn">ETOPS</span>`
    : `<span class="sect-flag">${escapeHtml(t('crz.etopsNo'))}</span>`;
}

/* ----------------------------------------------------------- fuel check */

const STATE_TONE = {
  onPlan: 'good',
  under: 'warn',
  overBurn: 'bad',
  belowMin: 'bad',
  none: ''
};

/** The section-header verdict: worst reading logged so far. */
export function summaryFlag(model, actuals) {
  const s = summarise(model, actuals);
  if (!s.count) return `<span class="sect-flag">${escapeHtml(t('nl.noReadings'))}</span>`;

  const tone = STATE_TONE[s.state] || '';
  return `<span class="sect-flag ${tone}">${escapeHtml(t(`nl.state.${s.state}`))} · <span class="ltr">${signedWeight(
    s.worst.diff,
    model.units
  )}</span></span>`;
}

/** Typographic minus, matching the diff cells rather than a stray hyphen. */
function signedWeight(value, units) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${fmtWeight(Math.abs(value), units)}`;
}

function fuelCheckBody(model, actuals, timeline, leg) {
  const fixes = model.navlog.filter((f) => Number.isFinite(f.fuelOnBoard));
  if (!fixes.length) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const unit = model.units === 'lbs' ? 'lb' : 'kg';
  const due = new Set(fuelCheckpoints(model).map((c) => c.fix.index));

  return `
    <div class="atc-note">
      ${icon('info', { size: 13 })}
      ${escapeHtml(t('nl.fuelCheckNote'))} ${fmtWeight(model.fuel.contingency, model.units)}
    </div>

    <div data-fuel-summary>${summaryPanel(model, actuals)}</div>

    <div class="table-scroll"><table class="rw-table fuelcheck-table">
      <thead><tr>
        <th>${escapeHtml(t('nl.ident'))}</th>
        <th>${escapeHtml(t('common.time'))}</th>
        <th>${escapeHtml(t('phase.eto'))}</th>
        <th>${escapeHtml(t('nl.planned'))} (${unit})</th>
        <th>${escapeHtml(t('nl.minimum'))} (${unit})</th>
        <th>${escapeHtml(t('nl.actual'))} (${unit})</th>
        <th>${escapeHtml(t('nl.diff'))}</th>
      </tr></thead>
      <tbody>${fixes
        .map((fix) => fuelRow(model, fix, actuals, timeline, leg, due.has(fix.index)))
        .join('')}</tbody>
    </table></div>
  `;
}

function fuelRow(model, fix, actuals, timeline, leg, isCheckpoint) {
  const actual = actuals[fix.index];
  const { state, diff } = classify(fix, actual, model.fuel.contingency);
  const eta = fixEta(model, timeline, fix);

  // Where the aircraft is now, and which rows are the ones to fill in.
  const passed = leg?.passed && fix.timeTotal <= leg.passed.timeTotal;
  const isNext = leg?.next && fix.index === leg.next.index;
  const cls = [
    passed ? 'passed' : '',
    isNext ? 'current' : '',
    isCheckpoint ? 'checkpoint' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return `<tr class="${cls}">
    <td><b>${escapeHtml(fix.ident)}</b>${isCheckpoint ? '<span class="fuel-due"></span>' : ''}</td>
    <td>${Number.isFinite(fix.timeTotal) ? fmtDuration(fix.timeTotal) : '—'}</td>
    <td class="${isNext ? 'eto-next' : 'dim'}">${eta ? escapeHtml(fmtZulu(eta)) : '—'}</td>
    <td>${fmtNumber(fix.fuelOnBoard)}</td>
    <td class="dim">${Number.isFinite(fix.fuelMinOnBoard) ? fmtNumber(fix.fuelMinOnBoard) : '—'}</td>
    <td>
      <!-- text + numeric inputmode + a digits-only pattern, not type="number":
           on iOS that combination is what raises the plain 0-9 keypad, while
           type="number" still offers punctuation a fuel figure never needs. -->
      <input class="fuel-input" type="text" inputmode="numeric" pattern="[0-9]*"
             enterkeyhint="done" autocomplete="off" maxlength="6"
             data-action="actual-fuel" data-fix-index="${fix.index}"
             value="${Number.isFinite(actual) ? actual : ''}"
             aria-label="${escapeHtml(`${t('nl.actual')} ${fix.ident}`)}">
    </td>
    <td data-fuel-diff="${fix.index}">${diffCell(state, diff)}</td>
  </tr>`;
}

/** Exported so a keystroke can repaint one cell without rebuilding the page. */
export function diffCell(state, diff) {
  if (state === 'none' || diff === null) return '<span class="fuel-diff">—</span>';
  const tone = STATE_TONE[state] || '';
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  return `<span class="fuel-diff ${tone}" title="${escapeHtml(state)}">${sign}${fmtNumber(Math.abs(diff))}</span>`;
}

/** Exported for the same reason: repaint on input, not a full re-render. */
export function summaryPanel(model, actuals) {
  const s = summarise(model, actuals);
  if (!s.count) return '';

  const cell = (label, value, tone = '') =>
    `<div><span class="k">${escapeHtml(label)}</span><span class="v ltr ${tone}">${value}</span></div>`;

  return `<div class="fuel-summary">
    ${cell(t('nl.logged'), `${s.count} / ${model.navlog.length}`)}
    ${cell(t('nl.latest'), `${escapeHtml(s.latest.fix.ident)} ${signedWeight(s.latest.diff, model.units)}`, STATE_TONE[s.latest.state])}
    ${cell(t('nl.worst'), `${escapeHtml(s.worst.fix.ident)} ${signedWeight(s.worst.diff, model.units)}`, STATE_TONE[s.worst.state])}
    ${cell(t('dep.contingency'), fmtWeight(s.contingency, model.units))}
  </div>`;
}

/* --------------------------------------------------------------- navlog */

/**
 * Every fix with the figures the OFP carries for it. Dense on purpose --
 * this is the reference table a crew scans in flight, not a summary.
 */
function fixTable(model) {
  const fixes = model.navlog;
  if (!fixes.length) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const headers = [
    t('nl.ident'),
    t('nl.via'),
    t('common.stage'),
    'ALT',
    t('common.wind'),
    t('nl.component'),
    'OAT',
    'ISA',
    'GS',
    t('common.distance'),
    t('common.time'),
    t('common.fuel'),
    'MORA'
  ];

  const rows = fixes
    .map((f) => {
      const cells = [
        `<b>${escapeHtml(f.ident)}</b>`,
        f.via ? escapeHtml(f.via) : '—',
        f.stage ? escapeHtml(f.stage) : '—',
        f.altitude ? fmtNumber(f.altitude) : '—',
        Number.isFinite(f.windDir) && Number.isFinite(f.windSpd) ? `${f.windDir}/${f.windSpd}` : '—',
        Number.isFinite(f.windComponent) ? signed(f.windComponent) : '—',
        f.oat === null ? '—' : `${f.oat}`,
        f.isaDev === null ? '—' : signed(f.isaDev),
        f.groundspeed ? String(f.groundspeed) : '—',
        Number.isFinite(f.distance) ? fmtNumber(f.distance) : '—',
        Number.isFinite(f.timeTotal) ? fmtDuration(f.timeTotal) : '—',
        Number.isFinite(f.fuelOnBoard) ? fmtNumber(f.fuelOnBoard) : '—',
        f.mora ? fmtNumber(f.mora) : '—'
      ];
      return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    })
    .join('');

  return `<div class="table-scroll"><table class="rw-table navlog-table">
    <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function firsBody(model) {
  const firs = model.route.firs;
  if (!firs.length) return `<div class="empty-state">${escapeHtml(t('common.none'))}</div>`;

  return `<div class="sect-pad">
    <div style="display:flex;gap:7px;flex-wrap:wrap">${firs.map((fir) => chip(fir, 'blue')).join('')}</div>
    ${model.route.section18 ? `<div class="wxrow-text" style="margin-block-start:12px">${escapeHtml(model.route.section18)}</div>` : ''}
  </div>`;
}
