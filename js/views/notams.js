/**
 * NOTAMs.
 *
 * One section per field plus the enroute set. Airport NOTAMs arrive already
 * decoded by SimBrief (subject, status, Q-code), so they sort by severity;
 * the enroute list is screened down from the full FIR dump because almost all
 * of it is obstacle and lighting detail that belongs to an airport briefing.
 */

import { t } from '../i18n.js';
import { escapeHtml, notamSeverity } from '../decode.js';
import { section, chip, notamListMarkup, getNotamFilter } from '../ui.js';
import { enrouteNotams } from '../charts.js';

export default function renderNotams({ model }) {
  const window = {
    start: model.times.estOut || model.times.schedOut,
    end: model.times.estIn || model.times.schedIn
  };

  const fields = [
    { airport: model.origin, role: t('nav.departure') },
    { airport: model.destination, role: t('nav.arrival') },
    ...model.alternates.map((a) => ({ airport: a, role: t('arr.alternate') }))
  ].filter((f) => f.airport);

  const enroute = enrouteNotams(model);

  return `
    <div class="cover">
      ${fields.map((f) => airportSection(f, window)).join('')}
      ${section(
        `${t('notam.enroute')} — ${enroute.kept} ${t('common.of')} ${enroute.total}`,
        'airspace',
        enroute.body,
        { action: enroute.live ? `<span class="sect-flag warn">${enroute.live} ${escapeHtml(t('sev.warning'))}</span>` : '' }
      )}
    </div>
  `;
}

function airportSection({ airport, role }, window) {
  const filter = getNotamFilter(airport.icao);
  const critical = airport.notams.filter((n) => notamSeverity(n, airport.plannedRunway) === 3).length;

  const badge = `${critical ? chip(`${critical} ${t('sev.critical')}`, 'red') : ''}${chip(
    `${airport.notams.length} ${t('notam.count')}`
  )}`;

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

  return section(
    `${role} — ${airport.icao}`,
    'runway',
    `${tools}<div data-notam-list data-icao="${airport.icao}">${notamListMarkup(airport, window)}</div>`,
    { action: `<span class="sect-flag ${critical ? 'bad' : ''}">${badge}</span>` }
  );
}
