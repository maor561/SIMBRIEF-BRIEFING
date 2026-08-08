/**
 * Navlog.
 *
 * The route flown as a table of fixes, plus the vertical plan around it:
 * step climbs, the airspace crossed, and whether the flight is ETOPS.
 */

import { t } from '../i18n.js';
import { escapeHtml, fmtNumber, fmtFeet, fmtWeight, fmtDuration } from '../decode.js';
import { section, chip, kv, tiles } from '../ui.js';
import { stepLadder, cruiseFactsBody } from '../charts.js';

export default function renderNavlog({ model }) {
  return `
    <div class="cover">
      ${section(t('nav.navlog'), 'routeSwap', fixTable(model), {
        action: `<span class="sect-flag">${model.navlog.length} ${escapeHtml(t('nl.fixes'))}</span>`
      })}
      ${section(t('crz.stepClimb'), 'aircraft', stepLadder(model))}
      ${section(t('crz.title'), 'wind', cruiseFactsBody(model))}
      ${section(t('crz.firs'), 'airspace', firsBody(model))}
    </div>
  `;
}

/**
 * Every fix with the figures the OFP carries for it. Dense on purpose --
 * this is the reference table a crew scans in flight, not a summary.
 */
function fixTable(model) {
  const fixes = model.navlog;
  if (!fixes.length) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const units = model.units;

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
    ${model.route.section18 ? `<div class="raw-wx" style="margin-block-start:12px">${escapeHtml(model.route.section18)}</div>` : ''}
  </div>`;
}
