/**
 * NOTAMs.
 *
 * One block per field plus the enroute set, following the airline-EFB NOTAM
 * page: the airport's identity strip on top, a search box with sort and
 * expand controls, then the notices as cards carrying age, number and
 * validity across a header row with the body's facility and condition words
 * picked out.
 *
 * Airport NOTAMs arrive already decoded by SimBrief (subject, status,
 * Q-code), so they can sort by severity. The enroute list is screened down
 * from the full FIR dump because almost all of it is obstacle and lighting
 * detail that belongs to an airport briefing.
 */

import { t } from '../i18n.js';
import { escapeHtml, notamSeverity } from '../decode.js';
import { section, chip, airportHead, notamControls, notamListMarkup } from '../ui.js';
import { enrouteNotams } from '../charts.js';

export default function renderNotams({ model }) {
  const window = {
    start: model.times.estOut || model.times.schedOut,
    end: model.times.estIn || model.times.schedIn
  };

  const fields = [
    {
      airport: model.origin,
      role: 'DEP',
      title: t('dep.title'),
      runways: model.tlr.takeoff?.runways?.map((r) => r.identifier),
      planned: model.tlr.takeoff?.plannedRunway || model.origin?.plannedRunway
    },
    {
      airport: model.destination,
      role: 'DEST',
      title: t('arr.title'),
      runways: model.tlr.landing?.runways?.map((r) => r.identifier),
      planned: model.tlr.landing?.plannedRunway || model.destination?.plannedRunway
    },
    ...model.alternates.map((a, i) => ({
      airport: a,
      role: model.alternates.length > 1 ? `ALTN ${i + 1}` : 'ALTN',
      title: t('arr.alternate'),
      runways: [a.plannedRunway],
      planned: a.plannedRunway
    }))
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

function airportSection({ airport, role, title, runways, planned }, window) {
  const critical = airport.notams.filter((n) => notamSeverity(n, airport.plannedRunway) === 3).length;

  const badge = `${critical ? chip(`${critical} ${t('sev.critical')}`, 'red') : ''}${chip(
    `${airport.notams.length} ${t('notam.count')}`
  )}`;

  const body = `
    ${airportHead(airport, role, runways, planned)}
    ${notamControls(airport.icao)}
    <div data-notam-list data-icao="${airport.icao}">${notamListMarkup(airport, window)}</div>
  `;

  return section(title, null, body, {
    action: `<span class="sect-flag ${critical ? 'bad' : ''}">${badge}</span>`,
    cls: critical ? 'accent-red' : ''
  });
}
