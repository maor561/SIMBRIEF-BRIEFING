/**
 * Chapter 2 — Takeoff.
 * The numbers needed on the runway, with the planned runway front and centre.
 */

import { t } from '../i18n.js';
import {
  escapeHtml,
  fmtNumber,
  fmtFeet,
  fmtWeight,
  decodeLimitCode,
  decodeSurface
} from '../decode.js';
import {
  card,
  flushCard,
  collapsible,
  tiles,
  kv,
  chip,
  meter,
  windRose,
  runwayBar,
  runwayTable,
  fixList,
  chapterHeading,
  chapterFindings,
  joinParts
} from '../ui.js';
import { THRESHOLDS } from '../analyze.js';

export default function renderTakeoff({ model, findings }) {
  const tlr = model.tlr.takeoff;
  const airport = model.origin;

  if (!tlr) {
    return `
      ${chapterHeading(t('to.title'), airport?.icao || '')}
      ${chapterFindings(findings, 'takeoff')}
      ${card({ title: t('to.perfFor'), body: `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>` })}
      ${departureRouteCard(model)}
    `;
  }

  const planned = tlr.runways.find((r) => r.identifier === tlr.plannedRunway) || tlr.runways[0];
  const others = tlr.runways.filter((r) => r !== planned);

  return `
    ${chapterHeading(
      joinParts([t('to.title'), tlr.airport || airport?.icao]),
      joinParts([t('common.runway'), tlr.plannedRunway], ' ')
    )}

    <div class="grid">
      ${findings.some((f) => f.chapter === 'takeoff') ? `<div class="col-12">${chapterFindings(findings, 'takeoff')}</div>` : ''}

      <div class="col-7">
        ${flushCard({
          title: `${t('to.perfFor')} — ${planned?.identifier || ''}`,
          badge: planned?.limitCode ? chip(`${t('to.limitedBy')}: ${decodeLimitCode(planned.limitCode)}`, 'amber') : '',
          body: plannedRunwayBody(model, tlr, planned)
        })}
      </div>

      <div class="col-5">
        ${card({ title: t('to.conditions'), body: conditionsBody(tlr, planned) })}
      </div>

      <div class="col-5">
        ${card({ title: t('to.config'), body: configBody(model, tlr, planned) })}
      </div>

      <div class="col-7">
        ${flushCard({ title: t('to.sid'), hint: model.route.sid || '', body: sidBody(model) })}
      </div>

      <div class="col-12">
        ${collapsible({
          title: `${t('to.otherRunways')} (${others.length})`,
          body: runwayTable(tlr)
        })}
      </div>
    </div>
  `;
}

/* The headline card: speeds, then the runway drawn to scale. */
function plannedRunwayBody(model, tlr, runway) {
  if (!runway) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const units = model.units;
  const hasSpeeds = runway.v1 || runway.vr || runway.v2;

  return `
    ${tiles([
      { label: 'V1', value: runway.v1 ?? '—', size: 'huge', tone: runway.v1 ? '' : '' },
      { label: 'VR', value: runway.vr ?? '—', size: 'huge' },
      { label: 'V2', value: runway.v2 ?? '—', size: 'huge' },
      runway.vref ? { label: runway.vrefId || 'VREF', value: runway.vref, size: 'big', tone: 'info' } : null
    ])}
    ${
      hasSpeeds
        ? ''
        : `<div class="img-note" style="padding:9px 13px 0">${escapeHtml(t('common.notAvailable'))} — V-speeds</div>`
    }

    <div style="padding:13px">
      ${runwayBar(runway)}
      ${kv([
        [t('to.decide'), runway.distanceDecide ? fmtFeet(runway.distanceDecide) : '—'],
        [t('to.reject'), runway.distanceReject ? fmtFeet(runway.distanceReject) : '—'],
        [t('to.stopMargin'), marginCell(runway.distanceMargin)],
        [t('to.continue'), runway.distanceContinue ? fmtFeet(runway.distanceContinue) : '—']
      ])}
    </div>

    <div style="padding:0 13px 13px">
      ${meter({
        label: t('to.weightLimit'),
        value: tlr.plannedWeight,
        max: runway.maxWeight,
        units,
        warnBelow: 500,
        badBelow: 0
      })}
    </div>

    <div style="padding:0 13px 13px">
      ${kv([
        ['TORA', runway.tora ? fmtFeet(runway.tora) : '—'],
        ['TODA', runway.toda ? fmtFeet(runway.toda) : '—'],
        ['ASDA', runway.asda ? fmtFeet(runway.asda) : '—'],
        [t('arr.gradient'), runway.gradient === null ? '—' : `${runway.gradient}%`],
        ['ILS', runway.ils || '—']
      ])}
    </div>
  `;
}

function marginCell(margin) {
  if (!Number.isFinite(margin)) return '—';
  const tone = margin < 100 ? 'var(--red)' : margin < THRESHOLDS.stopMarginFt ? 'var(--amber)' : 'var(--green)';
  return `<span style="color:${tone}">${fmtFeet(margin)}</span>`;
}

/* Wind first: the component figures are what decides technique. */
function conditionsBody(tlr, runway) {
  const headwind = runway?.headwind;
  const crosswind = runway?.crosswind;
  const isTailwind = Number.isFinite(headwind) && headwind < 0;

  const crosswindTone = !Number.isFinite(crosswind)
    ? ''
    : crosswind >= THRESHOLDS.crosswindCritical
    ? 'bad'
    : crosswind >= THRESHOLDS.crosswindCaution
    ? 'warn'
    : 'good';

  return `
    <div style="display:flex;gap:13px;align-items:center;margin-block-end:11px">
      ${windRose(tlr.windDir, tlr.windSpd, runway?.magneticCourse)}
      <div>
        <div class="num" style="font-size:20px;font-weight:700">${tlr.windDir ?? '—'}° / ${tlr.windSpd ?? '—'} kt</div>
        <div style="font-size:11.5px;color:var(--dimmer)">${escapeHtml(t('common.wind'))}</div>
      </div>
    </div>

    ${tiles([
      {
        label: isTailwind ? t('to.tailwind') : t('to.headwind'),
        value: Number.isFinite(headwind) ? String(Math.abs(headwind)) : '—',
        unit: 'kt',
        size: 'big',
        tone: isTailwind ? 'bad' : 'good'
      },
      {
        label: t('to.crosswind'),
        value: Number.isFinite(crosswind) ? String(crosswind) : '—',
        unit: 'kt',
        size: 'big',
        tone: crosswindTone
      }
    ])}

    <div style="padding-block-start:11px">
      ${kv([
        [t('common.temp'), tlr.temperature === null ? '—' : `${tlr.temperature}°C`],
        [t('common.qnh'), tlr.altimeter === null ? '—' : `${tlr.altimeter} inHg`],
        [t('to.surface'), decodeSurface(tlr.surface) || '—'],
        [t('common.planned'), fmtWeight(tlr.plannedWeight, 'kgs')]
      ])}
    </div>
  `;
}

function configBody(model, tlr, runway) {
  return kv([
    [t('to.flap'), runway?.flap || tlr.flap || '—'],
    [t('to.thrust'), runway?.thrust || '—'],
    [t('to.bleeds'), runway?.bleed || '—'],
    [t('to.antiIce'), runway?.antiIce || '—'],
    [t('to.flex'), runway?.flexTemp ? `${runway.flexTemp}°C` : '—'],
    [t('to.climbProfile'), model.flight.climbProfile || '—'],
    [t('to.initialAlt'), model.flight.initialAltitude ? fmtFeet(model.flight.initialAltitude) : '—'],
    [t('common.transAlt'), model.origin?.transAlt ? fmtFeet(model.origin.transAlt) : '—']
  ]);
}

/* Departure fixes, plus the highest terrain figure in the climb. */
function sidBody(model) {
  const climb = model.phases.climb;
  const sidFixes = climb.filter((f) => f.isSidStar);
  const shown = (sidFixes.length ? sidFixes : climb).slice(0, 8);
  const maxMora = climb.reduce((max, f) => (Number.isFinite(f.mora) && f.mora > max ? f.mora : max), 0);

  return `
    ${fixList(shown)}
    ${
      maxMora
        ? `<div class="row" style="background:var(--panel-2)">
             <span class="grow">${escapeHtml(t('crz.layer.terrain'))}</span>
             <span class="val">${fmtFeet(maxMora)}</span>
           </div>`
        : ''
    }
  `;
}

function departureRouteCard(model) {
  return flushCard({ title: t('to.sid'), body: fixList(model.phases.climb.slice(0, 8)) });
}
