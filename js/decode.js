/**
 * Decoders and formatters.
 *
 * METAR/TAF parsing is deliberately conservative: anything not confidently
 * understood is left in the raw text rather than guessed at, because a wrong
 * decode is worse than no decode in a briefing.
 */

import { t } from './i18n.js';
import { decodeWxToken, decodeNotamToken } from './glossary.js';

/* ------------------------------------------------------------------ format */

const NBSP = ' ';

/** Wraps aviation payloads so they stay left-to-right inside an RTL page. */
export function ltr(text) {
  return `<span class="ltr" dir="ltr">${escapeHtml(text)}</span>`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** NOTAM html from SimBrief contains only <b> tags; keep those, drop the rest. */
export function sanitizeNotamHtml(html) {
  // SimBrief marks emphasis with <b> and line breaks with <br>. Everything is
  // escaped first, then just those two are restored -- without the <br> case
  // the tag showed up as literal text in the middle of the notice.
  return escapeHtml(html)
    .replace(/&lt;(\/?)b&gt;/g, '<$1b>')
    .replace(/&lt;br\s*\/?&gt;/gi, '\n');
}

export function fmtNumber(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

export function fmtWeight(value, units = 'kgs') {
  if (value === null || value === undefined) return '—';
  return `${fmtNumber(value)}${NBSP}${units === 'lbs' ? 'lb' : 'kg'}`;
}

export function fmtFeet(value) {
  return value === null || value === undefined ? '—' : `${fmtNumber(value)}${NBSP}ft`;
}

/** Seconds -> H:MM. */
export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Seconds -> "1h 24m" style, for deltas where a colon reads oddly. */
export function fmtDurationShort(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.round(Math.abs(seconds) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const sign = seconds < 0 ? '−' : '';
  return h ? `${sign}${h}h ${m}m` : `${sign}${m}m`;
}

export function fmtZulu(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  return `${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
}

export function fmtZuluDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  const d = String(date.getUTCDate()).padStart(2, '0');
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][date.getUTCMonth()];
  return `${d}${mon} ${fmtZulu(date)}`;
}

export function fmtSigned(value, unit = '') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${fmtNumber(Math.abs(value))}${unit ? NBSP + unit : ''}`;
}

/* -------------------------------------------------------------- code tables */

/** SimBrief takeoff limit codes. */
const LIMIT_CODES = {
  F: { en: 'Field length' },
  O: { en: 'Obstacle' },
  C: { en: 'Climb gradient' },
  T: { en: 'Tyre speed' },
  B: { en: 'Brake energy' },
  // Every runway SimBrief marks 'A' shares one max weight regardless of its
  // length, so the binding limit is the airframe rather than the runway.
  A: { en: 'Aircraft structural' },
  L: { en: 'Structural' },
  V: { en: 'VMCG' },
  W: { en: 'Wind' },
  R: { en: 'Runway condition' }
};

export function decodeLimitCode(code) {
  if (!code) return null;
  const entry = LIMIT_CODES[code.toUpperCase()];
  if (!entry) return code;
  return entry.en;
}

const SURFACE = {
  dry: { he: 'יבש', en: 'Dry' },
  wet: { he: 'רטוב', en: 'Wet' },
  contaminated: { he: 'מזוהם', en: 'Contaminated' }
};

export function decodeSurface(value) {
  if (!value) return null;
  const entry = SURFACE[value.toLowerCase()];
  return entry ? entry.en : value;
}

/* -------------------------------------------------------------------- METAR */

const CLOUD_AMOUNT = {
  SKC: { he: 'שמיים נקיים', en: 'Sky clear', oktas: 0 },
  CLR: { he: 'שמיים נקיים', en: 'Clear', oktas: 0 },
  NSC: { he: 'ללא עננות משמעותית', en: 'No significant cloud', oktas: 0 },
  NCD: { he: 'לא זוהתה עננות', en: 'No cloud detected', oktas: 0 },
  FEW: { he: 'מועטה', en: 'Few', oktas: 2 },
  SCT: { he: 'מפוזרת', en: 'Scattered', oktas: 4 },
  BKN: { he: 'שבורה', en: 'Broken', oktas: 6 },
  OVC: { he: 'מלאה', en: 'Overcast', oktas: 8 },
  VV: { he: 'ראות אנכית', en: 'Vertical visibility', oktas: 8 }
};

const WX_PHENOMENA = {
  RA: { he: 'גשם', en: 'Rain' },
  SN: { he: 'שלג', en: 'Snow' },
  DZ: { he: 'טפטוף', en: 'Drizzle' },
  TS: { he: 'סופת רעמים', en: 'Thunderstorm' },
  SH: { he: 'ממטרים', en: 'Showers' },
  FG: { he: 'ערפל', en: 'Fog' },
  BR: { he: 'אובך לח', en: 'Mist' },
  HZ: { he: 'אובך', en: 'Haze' },
  FU: { he: 'עשן', en: 'Smoke' },
  DU: { he: 'אבק', en: 'Dust' },
  SA: { he: 'חול', en: 'Sand' },
  GR: { he: 'ברד', en: 'Hail' },
  GS: { he: 'ברד קטן', en: 'Small hail' },
  PL: { he: 'גרגרי קרח', en: 'Ice pellets' },
  FZ: { he: 'קופא', en: 'Freezing' },
  SQ: { he: 'משב פתאומי', en: 'Squall' },
  VC: { he: 'בסביבה', en: 'In vicinity' },
  MI: { he: 'רדוד', en: 'Shallow' },
  BC: { he: 'טלאים', en: 'Patches' },
  DR: { he: 'סחיפה נמוכה', en: 'Low drifting' },
  BL: { he: 'מנושב', en: 'Blowing' }
};

function phrase(entry) {
  return entry ? entry.en : null;
}

/**
 * Parses the body of a METAR. Returns structured fields plus `unparsed` for
 * tokens we chose not to interpret.
 */
export function parseMetar(rawText) {
  if (!rawText) return null;
  const raw = rawText.trim().replace(/\s+/g, ' ');
  const tokens = raw.split(' ');

  const out = {
    raw,
    station: null,
    issued: null,
    wind: null,
    visibility: null,
    cavok: false,
    clouds: [],
    weather: [],
    temperature: null,
    dewpoint: null,
    qnhHpa: null,
    qnhInHg: null,
    trend: null,
    unparsed: []
  };

  tokens.forEach((token, index) => {
    if (index === 0 && /^[A-Z]{4}$/.test(token)) {
      out.station = token;
      return;
    }
    if (/^\d{6}Z$/.test(token)) {
      out.issued = { day: +token.slice(0, 2), hour: +token.slice(2, 4), minute: +token.slice(4, 6) };
      return;
    }
    if (token === 'AUTO' || token === 'COR' || token === 'METAR' || token === 'SPECI') return;

    // Wind: 24014KT, 24014G26KT, VRB03KT, 00000KT
    let m = token.match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/);
    if (m) {
      const speedRaw = +m[2];
      const gustRaw = m[3] ? +m[3] : null;
      const toKt = m[4] === 'MPS' ? 1.94384 : m[4] === 'KMH' ? 0.539957 : 1;
      out.wind = {
        direction: m[1] === 'VRB' ? null : +m[1],
        variable: m[1] === 'VRB',
        speed: Math.round(speedRaw * toKt),
        gust: gustRaw === null ? null : Math.round(gustRaw * toKt),
        calm: speedRaw === 0,
        varyFrom: null,
        varyTo: null
      };
      return;
    }
    // Wind direction range: 330V070
    m = token.match(/^(\d{3})V(\d{3})$/);
    if (m && out.wind) {
      out.wind.varyFrom = +m[1];
      out.wind.varyTo = +m[2];
      return;
    }
    if (token === 'CAVOK') {
      out.cavok = true;
      return;
    }
    // Visibility in metres: 9999, 0800
    if (/^\d{4}$/.test(token)) {
      out.visibility = { metres: +token, unlimited: token === '9999' };
      return;
    }
    // Visibility in statute miles: 10SM, 1/2SM, M1/4SM
    m = token.match(/^(M)?(\d+)(?:\/(\d+))?SM$/);
    if (m) {
      const value = m[3] ? +m[2] / +m[3] : +m[2];
      out.visibility = { statuteMiles: value, below: Boolean(m[1]), metres: Math.round(value * 1609) };
      return;
    }
    // Clouds: FEW020, BKN014CB, VV003
    m = token.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
    if (m) {
      out.clouds.push({
        amount: m[1],
        amountText: phrase(CLOUD_AMOUNT[m[1]]),
        oktas: CLOUD_AMOUNT[m[1]]?.oktas ?? null,
        baseFt: +m[2] * 100,
        convective: m[3] || null
      });
      return;
    }
    if (['SKC', 'CLR', 'NSC', 'NCD'].includes(token)) {
      out.clouds.push({ amount: token, amountText: phrase(CLOUD_AMOUNT[token]), oktas: 0, baseFt: null });
      return;
    }
    // Temperature / dewpoint: 15/11, M02/M05
    m = token.match(/^(M?\d{1,2})\/(M?\d{1,2})$/);
    if (m) {
      const conv = (v) => (v.startsWith('M') ? -+v.slice(1) : +v);
      out.temperature = conv(m[1]);
      out.dewpoint = conv(m[2]);
      return;
    }
    // Pressure
    m = token.match(/^Q(\d{4})$/);
    if (m) {
      out.qnhHpa = +m[1];
      out.qnhInHg = Math.round((+m[1] / 33.8639) * 100) / 100;
      return;
    }
    m = token.match(/^A(\d{4})$/);
    if (m) {
      out.qnhInHg = +m[1] / 100;
      out.qnhHpa = Math.round((+m[1] / 100) * 33.8639);
      return;
    }
    if (['NOSIG', 'BECMG', 'TEMPO'].includes(token)) {
      out.trend = token;
      return;
    }
    // Present weather: -RA, +TSRA, VCSH, FZFG
    m = token.match(/^([-+]|VC)?((?:MI|BC|DR|BL|SH|TS|FZ|RA|SN|DZ|GR|GS|PL|FG|BR|HZ|FU|DU|SA|SQ){1,3})$/);
    if (m) {
      const codes = m[2].match(/.{2}/g) || [];
      out.weather.push({
        intensity: m[1] === '-' ? 'light' : m[1] === '+' ? 'heavy' : m[1] === 'VC' ? 'vicinity' : 'moderate',
        codes,
        text: codes.map((c) => phrase(WX_PHENOMENA[c])).filter(Boolean).join(' ')
      });
      return;
    }

    if (token && !/^(RMK|R\d{2}|NOSIG)/.test(token)) out.unparsed.push(token);
  });

  return out;
}

/** Human sentence for a parsed wind, in the current UI language. */
export function describeWind(wind) {
  if (!wind) return '—';
  if (wind.calm) return t('wx.calm');
  const dir = wind.variable ? t('wx.variable') : `${String(wind.direction).padStart(3, '0')}°`;
  const gust = wind.gust ? ` ${t('wx.gust')} ${wind.gust}` : '';
  return `${dir} / ${wind.speed}${gust} kt`;
}

/** Ceiling = lowest BKN/OVC/VV layer. */
export function ceilingOf(metar) {
  if (!metar) return null;
  const layers = metar.clouds.filter((c) => ['BKN', 'OVC', 'VV'].includes(c.amount) && c.baseFt !== null);
  if (!layers.length) return null;
  return Math.min(...layers.map((c) => c.baseFt));
}

/**
 * Head/cross wind components of `wind` relative to a runway magnetic course.
 * Positive headwind means wind on the nose.
 */
export function windComponents(windDir, windSpeed, runwayCourse) {
  if (![windDir, windSpeed, runwayCourse].every(Number.isFinite)) return null;
  const angle = ((windDir - runwayCourse + 540) % 360) - 180;
  const rad = (angle * Math.PI) / 180;
  return {
    headwind: Math.round(windSpeed * Math.cos(rad)),
    crosswind: Math.round(Math.abs(windSpeed * Math.sin(rad))),
    fromLeft: angle < 0
  };
}

/* ---------------------------------------------------------------------- TAF */

/**
 * Splits a TAF into its base period and change groups, resolving each group's
 * validity window to real dates so we can highlight the one covering a given
 * time. `reference` anchors the day-of-month fields to a month/year.
 */
export function parseTaf(rawText, reference) {
  if (!rawText) return null;
  const raw = rawText.trim();
  const anchor = reference instanceof Date && !Number.isNaN(reference.getTime()) ? reference : new Date();

  // Break before each change indicator so every group keeps its own text.
  const normalized = raw.replace(/\s+/g, ' ');
  const pieces = normalized.split(/\s(?=(?:BECMG|TEMPO|PROB\d{2}|FM\d{6}|INTER)\b)/);

  const groups = pieces.map((text, index) => {
    const group = {
      text: text.trim(),
      kind: 'base',
      probability: null,
      from: null,
      to: null,
      isBase: index === 0
    };

    const prob = text.match(/^PROB(\d{2})/);
    if (prob) group.probability = +prob[1];

    if (/^BECMG/.test(text)) group.kind = 'BECMG';
    else if (/^TEMPO/.test(text) || /PROB\d{2}\s+TEMPO/.test(text)) group.kind = 'TEMPO';
    else if (/^INTER/.test(text)) group.kind = 'INTER';
    else if (/^FM\d{6}/.test(text)) group.kind = 'FM';
    else if (prob) group.kind = 'PROB';

    const fm = text.match(/FM(\d{2})(\d{2})(\d{2})/);
    if (fm) {
      group.from = dayHourToDate(+fm[1], +fm[2], anchor, +fm[3]);
    } else {
      const window = text.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);
      if (window) {
        group.from = dayHourToDate(+window[1], +window[2], anchor);
        group.to = dayHourToDate(+window[3], +window[4], anchor);
      }
    }

    return group;
  });

  // A base period's window is the whole TAF validity; FM groups run to the next one.
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i].kind === 'FM' && !groups[i].to) {
      const next = groups.slice(i + 1).find((g) => g.kind === 'FM');
      groups[i].to = next?.from || groups[0].to;
    }
  }

  return { raw, groups, validFrom: groups[0]?.from || null, validTo: groups[0]?.to || null };
}

/** Resolves a TAF day-of-month + hour against a reference month, handling rollover. */
function dayHourToDate(day, hour, reference, minute = 0) {
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  let date = new Date(Date.UTC(year, month, day, hour === 24 ? 0 : hour, minute));
  if (hour === 24) date = new Date(date.getTime() + 24 * 3600 * 1000);

  // A day number well below the reference means the TAF rolls into next month.
  const dayGap = day - reference.getUTCDate();
  if (dayGap < -20) date = new Date(Date.UTC(year, month + 1, day, hour === 24 ? 0 : hour, minute));
  else if (dayGap > 20) date = new Date(Date.UTC(year, month - 1, day, hour === 24 ? 0 : hour, minute));

  return date;
}

/** True when `time` falls inside the group's validity window. */
export function groupCovers(group, time) {
  if (!group?.from || !(time instanceof Date)) return false;
  const end = group.to || new Date(group.from.getTime() + 6 * 3600 * 1000);
  return time >= group.from && time <= end;
}

/* ------------------------------------------------------------------- NOTAMs */

const AERODROME_SUBJECTS = /aerodrome|airport/i;
const RUNWAY_SUBJECTS = /runway/i;
const IMPORTANT_SUBJECTS = /taxiway|apron|ils|localizer|glide|navaid|vor|dme|ndb|light|approach|rvr|fuel/i;
const BLOCKING_STATUS = /clos|unserviceable|u\/s|out of service|withdrawn|not available|unavailable/i;
const DEGRADED_STATUS = /limit|restrict|displaced|reduc|chang|work in progress/i;

/**
 * Ranks a NOTAM using the Q-code fields SimBrief already decoded.
 * Returns 3 (critical), 2 (warning) or 1 (info).
 *
 * A closed runway is only critical when it is the runway actually planned for.
 * A different runway at the same field is worth knowing about, but calling it
 * critical would cry wolf on most briefings.
 */
export function notamSeverity(notam, plannedRunway) {
  const subject = notam.subject || '';
  const status = notam.status || '';
  const body = `${notam.text || ''} ${notam.raw || ''}`;

  if (notam.isObstacle) return 1;

  const blocking = BLOCKING_STATUS.test(status);
  const degraded = DEGRADED_STATUS.test(status);

  // The whole field going away always matters.
  if (blocking && AERODROME_SUBJECTS.test(subject)) return 3;

  if (blocking && RUNWAY_SUBJECTS.test(subject)) {
    if (!plannedRunway) return 3;
    return mentionsRunway(body, plannedRunway) ? 3 : 2;
  }

  if (blocking && IMPORTANT_SUBJECTS.test(subject)) return 2;
  if (degraded && (RUNWAY_SUBJECTS.test(subject) || AERODROME_SUBJECTS.test(subject) || IMPORTANT_SUBJECTS.test(subject))) {
    return 2;
  }
  return 1;
}

/** Runway designators appearing in free text: 24, 24L, 06R, with optional leading zero. */
const RUNWAY_TOKEN = /\b(\d{1,2})([LRC])?\b/gi;

/**
 * Does the text refer to this specific runway?
 *
 * Suffix letters are significant: at a field with 06L/24R and 06R/24L, a NOTAM
 * closing 24R says nothing about a departure from 24L. A designator without a
 * suffix (either in the text or in the plan) is treated as covering the pair,
 * which errs towards showing the crew too much rather than too little.
 */
export function mentionsRunway(text, runway) {
  if (!text || !runway) return false;
  const planned = String(runway).match(/^(\d{1,2})([LRC])?/i);
  if (!planned) return false;

  const plannedNumber = Number(planned[1]);
  const plannedSuffix = (planned[2] || '').toUpperCase();

  RUNWAY_TOKEN.lastIndex = 0;
  let match;
  while ((match = RUNWAY_TOKEN.exec(text)) !== null) {
    const number = Number(match[1]);
    const suffix = (match[2] || '').toUpperCase();
    if (number !== plannedNumber || number < 1 || number > 36) continue;
    if (!suffix || !plannedSuffix || suffix === plannedSuffix) return true;
  }
  return false;
}

/* ------------------------------------------------- enroute NOTAM screening */

/**
 * Enroute NOTAMs arrive from a different SimBrief node than the airport ones
 * and carry only the raw ICAO Q-code, so subject and condition are decoded here.
 *
 * Q-code layout: Q + two letters of subject + two letters of condition.
 */
const QCODE_SUBJECTS = {
  // Airspace and activity — what actually affects an aircraft in the cruise.
  RP: { he: 'אזור אסור', en: 'Prohibited area', enroute: true },
  RD: { he: 'אזור מסוכן', en: 'Danger area', enroute: true },
  RR: { he: 'אזור מוגבל', en: 'Restricted area', enroute: true },
  RM: { he: 'אזור אימונים צבאי', en: 'Military operating area', enroute: true },
  RT: { he: 'אזור מוגבל זמנית', en: 'Temporary restricted area', enroute: true },
  RA: { he: 'הקצאת מרחב אווירי', en: 'Airspace reservation', enroute: true },
  RO: { he: 'אזור חסום', en: 'Overflying restricted', enroute: true },
  WM: { he: 'ירי טילים / ארטילריה', en: 'Missile or gunnery firing', enroute: true },
  WE: { he: 'תרגיל צבאי', en: 'Military exercise', enroute: true },
  WP: { he: 'צניחה חופשית', en: 'Parachute jumping', enroute: true },
  WU: { he: 'כלי טיס בלתי מאויש', en: 'Unmanned aircraft', enroute: true },
  WL: { he: 'קרן לייזר', en: 'Laser activity', enroute: true },
  WA: { he: 'מופע אווירי', en: 'Air display', enroute: true },
  WB: { he: 'ירי / זיקוקים', en: 'Aerobatics or firing', enroute: true },
  WZ: { he: 'פעילות חריגה', en: 'Hazard activity', enroute: true },
  AR: { he: 'נתיב ATS', en: 'ATS route', enroute: true },
  AF: { he: 'מרחב אווירי / FIR', en: 'FIR or airspace', enroute: true },
  AC: { he: 'אזור בקרה', en: 'Control area', enroute: true },
  AN: { he: 'אזור ניווט', en: 'Navigation area', enroute: true },
  AA: { he: 'גובה מינימלי', en: 'Minimum altitude', enroute: true },

  // Ground and airport subjects: briefed per airport, not in the cruise.
  OB: { he: 'מכשול', en: 'Obstacle', enroute: false },
  OL: { he: 'תאורת מכשול', en: 'Obstacle lighting', enroute: false },
  MR: { he: 'מסלול', en: 'Runway', enroute: false },
  MX: { he: 'מסלול הסעה', en: 'Taxiway', enroute: false },
  MN: { he: 'מפרש חניה', en: 'Apron', enroute: false },
  FA: { he: 'שדה תעופה', en: 'Aerodrome', enroute: false }
};

/** Conditions that mean the airspace or activity is live. */
const QCODE_ACTIVE = /^(CA|CS|LW|LC|LT|LP|AS|AW|CE)$/;

const QCODE_CONDITIONS = {
  CA: { he: 'פעיל', en: 'Activated' },
  CS: { he: 'פעיל לסירוגין', en: 'Intermittently activated' },
  CE: { he: 'הורחב', en: 'Extended' },
  CH: { he: 'שונה', en: 'Changed' },
  CD: { he: 'הופחת', en: 'Deactivated' },
  LC: { he: 'סגור', en: 'Closed' },
  LW: { he: 'סגור לעבודות', en: 'Closed for work' },
  LT: { he: 'מוגבל', en: 'Limited' },
  LP: { he: 'מוגבל חלקית', en: 'Partly limited' },
  AS: { he: 'לא כשיר', en: 'Unserviceable' },
  AW: { he: 'בוטל', en: 'Withdrawn' },
  AH: { he: 'שעות שונו', en: 'Hours changed' },
  XX: { he: 'טקסט חופשי', en: 'Plain language' },
  TT: { he: 'שינוי זמני', en: 'Temporary change' }
};

/**
 * Screens an enroute NOTAM for cruise relevance.
 * Returns { keep, severity, subject, condition } — severity 2 when the
 * airspace or activity is live, 1 when it is informational.
 */
export function screenEnrouteNotam(notam) {
  const qcode = (notam.qcode || '').toUpperCase();
  const match = qcode.match(/^Q([A-Z]{2})([A-Z]{2})$/);
  if (!match) return { keep: false, severity: 1, subject: null, condition: null };

  const [, subjectCode, conditionCode] = match;
  const subject = QCODE_SUBJECTS[subjectCode];

  // The Q-code's first letter groups the subject. Only airspace restrictions
  // (QR), warnings (QW) and ATM (QA) describe something an aircraft in the
  // cruise flies through; the rest are aerodrome, navaid and service items that
  // belong to the airport chapters. Screening by group rather than by a lookup
  // hit means an unlisted code in an irrelevant group is still dropped.
  const relevantGroup = /^[RWA]$/.test(subjectCode[0]);

  if (!relevantGroup || (subject && !subject.enroute)) {
    return { keep: false, severity: 1, subject: subject ? phrase(subject) : null, condition: null };
  }

  const condition = QCODE_CONDITIONS[conditionCode];
  const live = QCODE_ACTIVE.test(conditionCode);

  return {
    keep: true,
    severity: subject && live ? 2 : 1,
    subject: subject ? phrase(subject) : subjectCode,
    condition: condition ? phrase(condition) : conditionCode
  };
}

/** Is the NOTAM in force at any point between `start` and `end`? */
export function notamActiveDuring(notam, start, end) {
  if (!start || !end) return true;
  const from = notam.effective ? new Date(notam.effective) : null;
  const to = notam.expires ? new Date(notam.expires) : null;
  if (from && !Number.isNaN(from.getTime()) && from > end) return false;
  if (to && !Number.isNaN(to.getTime()) && to < start) return false;
  return true;
}

/**
 * Derives the flight category from a parsed METAR.
 *
 * The OFP hands its category over ready-made, so this exists only for live
 * observations, where there is nothing but the raw string. The bands are the
 * usual ceiling/visibility ones, and the worse of the two wins:
 *
 *   LIFR  ceiling < 500 ft   or visibility < 1 sm
 *   IFR   ceiling < 1,000 ft or visibility < 3 sm
 *   MVFR  ceiling < 3,000 ft or visibility < 5 sm
 *   VFR   anything above
 *
 * No ceiling means no ceiling limit, not an unknown -- a clear sky is judged
 * on visibility alone. A METAR with neither returns null rather than guessing.
 */
export function flightCategory(metar) {
  if (!metar) return null;
  if (metar.cavok) return 'vfr';

  const ceiling = ceilingOf(metar);
  const metres = metar.visibility?.unlimited ? 9999 : metar.visibility?.metres ?? null;
  if (ceiling === null && metres === null) return null;

  const rank = Math.max(
    ceiling === null ? 0 : ceiling < 500 ? 3 : ceiling < 1000 ? 2 : ceiling < 3000 ? 1 : 0,
    metres === null ? 0 : metres < 1600 ? 3 : metres < 5000 ? 2 : metres < 8000 ? 1 : 0
  );

  return ['vfr', 'mvfr', 'ifr', 'lifr'][rank];
}

/** How bad a category is, for comparing a live observation against the plan. */
export function categoryRank(category) {
  return ['vfr', 'mvfr', 'ifr', 'lifr'].indexOf((category || '').toLowerCase());
}

/** Flight-category colour class for a METAR category string. */
export function categoryClass(category) {
  switch ((category || '').toLowerCase()) {
    case 'vfr':
      return 'cat-vfr';
    case 'mvfr':
      return 'cat-mvfr';
    case 'ifr':
      return 'cat-ifr';
    case 'lifr':
      return 'cat-lifr';
    default:
      return 'cat-unknown';
  }
}

/**
 * Which icon best represents a NOTAM's subject, so a list reads by shape and
 * colour before anyone reads a word of it -- the same idea EFBs use for
 * graphical NOTAMs on an airport diagram, applied to a text list.
 */
export function notamIconName(notam) {
  const subject = `${notam.subject || ''} ${notam.text || notam.raw || ''}`.toLowerCase();
  if (notam.isObstacle || /obstacle|crane|antenna/.test(subject)) return 'obstacle';
  if (/light/.test(subject)) return 'lighting';
  if (/taxiway|twy/.test(subject)) return 'taxiway';
  if (/runway|rwy/.test(subject)) return 'runway';
  if (/airspace|restricted|danger|military|aerodrome|ad ltd/.test(subject)) return 'airspace';
  return 'info';
}

/**
 * Colour-codes the hazardous tokens inside a raw METAR/TAF the way airline
 * EFBs do: the text stays exactly as issued, but CBs, thunderstorms, low
 * visibility and the like jump out without anyone reading the whole string.
 * Red is "this changes the plan", amber is "this deserves a look".
 */
/**
 * Tokens that decode get `data-gloss="wx"` and their bare code in
 * `data-code`, tapped to a definition by a click handler elsewhere -- the
 * definition itself is looked up again at tap time from `glossary.js` rather
 * than baked into the markup here, so there is exactly one place that knows
 * what any given code means.
 */
/**
 * `context: 'sigmet'` is passed for SIGMET bodies. The vocabulary is almost
 * entirely shared with METAR/TAF -- TS, VA, FZ and the rest mean the same
 * thing everywhere -- but the one validity-window pattern (`1030/1430`) is
 * genuinely ambiguous between a TAF's day/hour and a SIGMET's hour/minute,
 * so that one decode needs to know which vocabulary it is reading. See
 * glossary.js for the detail.
 */
export function highlightWx(raw, context) {
  if (!raw) return '';
  return String(raw)
    .split(/(\s+)/)
    .map((token) => {
      if (!token.trim()) return escapeHtml(token);
      const upper = token.toUpperCase();
      const cls = classifyWxToken(upper);
      const escaped = escapeHtml(token);
      const gloss = decodeWxToken(upper, context);

      if (!cls && !gloss) return escaped;

      const classes = [cls, gloss ? 'gl' : null].filter(Boolean).join(' ');
      const attrs = gloss
        ? ` data-gloss="${context === 'sigmet' ? 'sigmet' : 'wx'}" data-code="${escapeHtml(upper)}"`
        : '';
      return `<span class="${classes}"${attrs}>${escaped}</span>`;
    })
    .join('');
}

/**
 * Colour-codes a NOTAM body the same way: the facility a notice is about
 * reads amber, the condition that makes it matter reads as a red badge. The
 * text stays exactly as issued -- only its emphasis changes.
 */
export function highlightNotam(raw) {
  if (!raw) return '';
  return String(raw)
    .split(/(\s+)/)
    .map((token) => {
      if (!token.trim()) return escapeHtml(token);
      const bare = token.toUpperCase().replace(/[.,;:]+$/, '');
      const escaped = escapeHtml(token);
      const gloss = decodeNotamToken(bare);
      const cls = NOTAM_STATUS.has(bare) ? 'wx-bad' : NOTAM_SUBJECT.has(bare) ? 'wx-warn' : null;

      if (!cls && !gloss) return escaped;

      const classes = [cls, gloss ? 'gl' : null].filter(Boolean).join(' ');
      const attrs = gloss ? ` data-gloss="notam" data-code="${escapeHtml(bare)}"` : '';
      return `<span class="${classes}"${attrs}>${escaped}</span>`;
    })
    .join('');
}

/* Conditions that take capability away -- the words that change the plan. */
const NOTAM_STATUS = new Set([
  'CLSD', 'CLOSED', 'U/S', 'UNSERVICEABLE', 'UNSVBL', 'WIP', 'PROHIBITED',
  'DANGER', 'SUSPENDED', 'WITHDRAWN', 'CNL', 'CANCELLED'
]);

/* The facility a notice is about, plus the qualifiers that condition it.
   AVBL and LTD sit here rather than above: they narrow what is on offer,
   they do not withdraw it. */
const NOTAM_SUBJECT = new Set([
  'RWY', 'TWY', 'ILS', 'GATE', 'APRON', 'STAND', 'PAPI', 'VASI', 'DME', 'VOR',
  'NDB', 'LOC', 'GP', 'ALS', 'RVR', 'LGT', 'LGTS', 'AD', 'OBST', 'CRANE',
  'GLD', 'SID', 'STAR', 'IAP', 'FATO', 'HEL',
  'LTD', 'PPR', 'AVBL', 'ACTIVATED', 'ACTIVE'
]);

function classifyWxToken(token) {
  // Convective cloud, thunder, freezing precip, hail, fog and the rare
  // severe phenomena (squall, funnel cloud, ash, sand/dust storm).
  if (/(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)/.test(token) || token === 'CB' || token === 'TCU') return 'wx-bad';
  if (/^(\+|-|VC)?(TS|FZ)/.test(token)) return 'wx-bad';
  // Anchored at the end too: SQ/FC/VA/SS/DS are standalone phenomena codes in
  // the WMO table, never a descriptor that something else is appended to --
  // unlike a prefix match, which also (wrongly) lit up on any ordinary English
  // word that happens to start with one, most commonly "VALID" at the top of
  // every SIGMET.
  if (/^(\+|-|VC)?(SQ|FC|VA|SS|DS)$/.test(token)) return 'wx-bad';
  if (/^(\+|VC)?FG$/.test(token)) return 'wx-bad';
  if (/^\+/.test(token)) return 'wx-bad'; // any heavy (+) weather group

  // Visibility in metres.
  if (/^\d{4}$/.test(token)) {
    const metres = Number(token);
    if (metres < 1500) return 'wx-bad';
    if (metres < 5000) return 'wx-warn';
    return null;
  }

  // Ceiling height.
  const cloud = token.match(/^(BKN|OVC|VV)(\d{3})/);
  if (cloud) {
    const hundreds = Number(cloud[2]);
    if (hundreds <= 4) return 'wx-bad';
    if (hundreds <= 10) return 'wx-warn';
    return null;
  }

  // Wind: gusts always, steady wind from 25 kt.
  const wind = token.match(/^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?(KT|MPS)$/);
  if (wind) {
    if (wind[4]) return 'wx-warn';
    if (Number(wind[2]) >= 25) return 'wx-warn';
    return null;
  }

  if (/^PROB\d{2}$/.test(token) || token === 'TEMPO' || token === 'INTER') return 'wx-warn';
  if (/^(-|VC)?(SH)?(RA|SN|DZ|PL|SG|IC|UP)$/.test(token)) return 'wx-warn';
  if (/^(BR|HZ|FU|DU|SA)$/.test(token)) return 'wx-warn';
  if (/^R\d{2}[LRC]?\//.test(token)) return 'wx-warn'; // RVR group

  return null;
}
