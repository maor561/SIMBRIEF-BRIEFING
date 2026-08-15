/**
 * Decodes a single METAR/TAF or NOTAM token into plain English.
 *
 * A METAR reads fluently to someone who flies with it every day and as a wall
 * of cryptic groups to everyone else -- and a briefing meant to be handed to
 * a passenger, a new crew member, or just read at 4am deserves better than a
 * glossary printed on a laminated card in a drawer somewhere. This is that
 * card, but looked up per token instead of read start to finish.
 *
 * Two decoders, because the two vocabularies barely overlap:
 *
 *   decodeWxToken     METAR/TAF/SIGMET groups -- wind, cloud, visibility,
 *                      weather phenomena, altimeter, the TAF change indicators.
 *                      Compound tokens are parsed structurally rather than
 *                      matched whole, so "09007KT" and "27015G28KT" both
 *                      decode without being individually listed.
 *   decodeNotamToken   The abbreviations NOTAM prose is built from -- mostly a
 *                      fixed vocabulary, so a dictionary is the right shape.
 *
 * Both take the token exactly as it appears in the source text and return a
 * short English sentence, or null when nothing is recognised. Returning null
 * rather than guessing is deliberate: a wrong decode is worse than no decode,
 * and plenty of tokens (ICAO codes, fix names, bare numbers) have no
 * abbreviation to expand.
 */

/** Strips the punctuation prose tacks onto a word, not part of the code itself. */
function bare(token) {
  return String(token || '')
    .toUpperCase()
    .replace(/^[.,;:()]+|[.,;:()]+$/g, '');
}

/* ------------------------------------------------------------- METAR/TAF */

const INTENSITY = { '-': 'Light', '+': 'Heavy' };

const DESCRIPTOR = {
  MI: 'shallow',
  PR: 'partial',
  BC: 'patches of',
  DR: 'low drifting',
  BL: 'blowing',
  SH: 'showers of',
  TS: 'thunderstorm with',
  FZ: 'freezing'
};

const PRECIP = {
  DZ: 'drizzle',
  RA: 'rain',
  SN: 'snow',
  SG: 'snow grains',
  IC: 'ice crystals',
  PL: 'ice pellets',
  GR: 'hail',
  GS: 'small hail / snow pellets',
  UP: 'unknown precipitation'
};

const OBSCURATION = {
  BR: 'mist',
  FG: 'fog',
  FU: 'smoke',
  VA: 'volcanic ash',
  DU: 'widespread dust',
  SA: 'sand',
  HZ: 'haze',
  PY: 'spray',
  PO: 'dust/sand whirls',
  SQ: 'squall',
  FC: 'funnel cloud (or tornado/waterspout)',
  SS: 'sandstorm',
  DS: 'duststorm'
};

const CLOUD_AMOUNT = {
  FEW: 'Few',
  SCT: 'Scattered',
  BKN: 'Broken',
  OVC: 'Overcast',
  VV: 'Vertical visibility (sky obscured)'
};

/** Standalone codes that do not fit a structural pattern. */
const WX_WORDS = {
  CAVOK: 'Ceiling and visibility OK: visibility 10 km or more, no cloud below 5,000 ft, no significant weather',
  NOSIG: 'No significant change expected in the next two hours',
  NSC: 'No significant cloud',
  NCD: 'No cloud detected (automated station)',
  SKC: 'Sky clear',
  CLR: 'Clear below 12,000 ft (automated station)',
  AUTO: 'Fully automated observation, not checked by a human',
  COR: 'Correction to a previously issued report',
  AMD: 'Amended forecast',
  CNL: 'Forecast cancelled',
  RMK: 'Remarks follow',
  WS: 'Wind shear',
  VRB: 'Variable direction',
  CB: 'Cumulonimbus',
  TCU: 'Towering cumulus',
  TEMPO: 'Temporary fluctuation expected for under an hour at a time',
  BECMG: 'Gradual, lasting change expected within the period given',
  KT: 'Knots',
  MPS: 'Metres per second',
  SM: 'Statute miles',
  FT: 'Feet',
  ALL: 'All',
  RWY: 'Runway'
};

/**
 * Structural decoders, tried in order. Each returns a sentence or null; the
 * first match wins, so more specific patterns (wind, cloud) are tried before
 * anything that could coincidentally match a shorter, looser one.
 */
const WX_PATTERNS = [
  // Wind: 09007KT, 27015G28KT, VRB03MPS.
  {
    match: /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/,
    decode: ([, dir, speed, gust, unit]) => {
      const unitName = { KT: 'kt', MPS: 'm/s', KMH: 'km/h' }[unit];
      const dirText = dir === 'VRB' ? 'Variable direction' : `From ${dir}°`;
      return `${dirText} at ${Number(speed)}${gust ? `, gusting ${Number(gust)}` : ''} ${unitName}`;
    }
  },
  // Variable wind direction group: 060V150.
  {
    match: /^(\d{3})V(\d{3})$/,
    decode: ([, from, to]) => `Wind direction varies between ${from}° and ${to}°`
  },
  // Cloud: BKN012, OVC004CB, SCT250TCU, VV002.
  {
    match: /^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/,
    decode: ([, amount, height, type]) =>
      `${CLOUD_AMOUNT[amount]}${amount === 'VV' ? '' : ' cloud'} at ${(Number(height) * 100).toLocaleString(
        'en-US'
      )} ft${type ? `, ${type === 'CB' ? 'cumulonimbus' : 'towering cumulus'}` : ''}`
  },
  // Visibility in metres: 9999, 0400.
  {
    match: /^\d{4}$/,
    decode: ([token]) =>
      token === '9999'
        ? 'Visibility 10 km or more'
        : `Visibility ${Number(token).toLocaleString('en-US')} m`
  },
  // Visibility in statute miles: 10SM, 1/2SM, M1/4SM.
  {
    match: /^(M)?(\d+(?:\/\d+)?)SM$/,
    decode: ([, less, value]) => `Visibility ${less ? 'less than ' : ''}${value} statute miles`
  },
  // Runway visual range: R28/1000, R32L/P2000V4000FT, R09/M0150U.
  {
    match: /^R(\d{2}[LCR]?)\/(P|M)?(\d{3,4})(?:V(P|M)?(\d{3,4}))?(FT)?([UDN])?$/,
    decode: ([, rwy, lo, val, , hi, ft, trend]) => {
      const unit = ft ? 'ft' : 'm';
      const qual = (q) => (q === 'P' ? 'more than ' : q === 'M' ? 'less than ' : '');
      const range = hi
        ? `${qual(lo)}${val}${unit} to ${hi}${unit}`
        : `${qual(lo)}${val}${unit}`;
      const trendText = { U: ', improving', D: ', worsening', N: ', steady' }[trend] || '';
      return `Runway visual range, RWY ${rwy}: ${range}${trendText}`;
    }
  },
  // Temperature/dewpoint: 18/12, M03/M07.
  {
    match: /^(M?\d{2})\/(M?\d{2})$/,
    decode: ([, t, d]) => {
      const c = (v) => (v.startsWith('M') ? `-${v.slice(1)}` : v);
      return `Temperature ${c(t)}°C, dew point ${c(d)}°C`;
    }
  },
  // Altimeter/QNH: Q1013, A2992.
  { match: /^Q(\d{4})$/, decode: ([, v]) => `QNH ${v} hPa` },
  { match: /^A(\d{4})$/, decode: ([, v]) => `Altimeter ${v.slice(0, 2)}.${v.slice(2)} inHg` },
  // Observation time: 101630Z (day 10, 16:30Z).
  {
    match: /^(\d{2})(\d{2})(\d{2})Z$/,
    decode: ([, day, hh, mm]) => `Observed on day ${day} at ${hh}:${mm}Z`
  },
  // TAF change-from time: FM211800 (day 21, 18:00Z).
  {
    match: /^FM(\d{2})(\d{2})(\d{2})$/,
    decode: ([, day, hh, mm]) => `From day ${day}, ${hh}:${mm}Z`
  },
  // TAF/period validity: 1006/1008 (day 10 06Z to day 10 08Z).
  {
    match: /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/,
    decode: ([, d1, h1, d2, h2]) => `Valid day ${d1} ${h1}:00Z to day ${d2} ${h2}:00Z`
  },
  // Probability: PROB30, PROB40.
  { match: /^PROB(\d{2})$/, decode: ([, pct]) => `${pct}% probability` },
  // Weather phenomena, decoded left to right: -SHRA, +TSRA, VCSH, BR, FZDZ.
  {
    match: /^(-|\+|VC)?((?:MI|PR|BC|DR|BL|SH|TS|FZ){0,2})((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP)*)((?:BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*)$/,
    decode: ([whole, intensity, descriptor, precip, obsc]) => {
      // The pattern also matches the empty string; only accept it when at
      // least one real group was actually found.
      if (!intensity && !descriptor && !precip && !obsc) return null;

      const parts = [];
      if (intensity === 'VC') parts.push('In the vicinity:');
      else if (INTENSITY[intensity]) parts.push(INTENSITY[intensity]);

      for (let i = 0; i < descriptor.length; i += 2) parts.push(DESCRIPTOR[descriptor.slice(i, i + 2)]);
      for (let i = 0; i < precip.length; i += 2) parts.push(PRECIP[precip.slice(i, i + 2)]);
      for (let i = 0; i < obsc.length; i += 2) parts.push(OBSCURATION[obsc.slice(i, i + 2)]);

      return parts.filter(Boolean).length ? capitalize(parts.filter(Boolean).join(' ')) : null;
    }
  }
];

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Decodes one METAR/TAF/SIGMET token. Structural patterns are tried first
 * because they cover the tokens that actually carry the flight-relevant
 * numbers; the dictionary catches the fixed vocabulary around them.
 */
export function decodeWxToken(token) {
  const code = bare(token);
  if (!code) return null;

  for (const { match, decode } of WX_PATTERNS) {
    const hit = code.match(match);
    if (hit) {
      const result = decode(hit);
      if (result) return result;
    }
  }

  return WX_WORDS[code] || null;
}

/* ------------------------------------------------------------------ NOTAM */

/**
 * The abbreviations NOTAM prose is built from. Unlike METAR this is close to
 * a closed vocabulary -- there is no arithmetic to parse out of "WEF" the way
 * there is out of a wind group -- so a dictionary is the whole decoder.
 */
const NOTAM_WORDS = {
  // Status: what changed.
  CLSD: 'Closed',
  CLOSED: 'Closed',
  'U/S': 'Unserviceable (out of service)',
  UNSVBL: 'Unserviceable',
  UNSERVICEABLE: 'Unserviceable',
  WIP: 'Work in progress',
  WITHDRAWN: 'Withdrawn',
  SUSPENDED: 'Suspended',
  CNL: 'Cancelled',
  CANCELLED: 'Cancelled',
  ACTIVATED: 'Activated',
  ACTIVE: 'Active',
  AVBL: 'Available',
  LTD: 'Limited',
  PROHIBITED: 'Prohibited',
  DANGER: 'Danger',

  // What it concerns.
  RWY: 'Runway',
  TWY: 'Taxiway',
  ILS: 'Instrument Landing System',
  PAPI: 'Precision Approach Path Indicator',
  VASI: 'Visual Approach Slope Indicator',
  DME: 'Distance Measuring Equipment',
  VOR: 'VHF Omnidirectional Range (navigation beacon)',
  NDB: 'Non-Directional Beacon',
  LOC: 'Localizer',
  GP: 'Glide Path',
  ALS: 'Approach Lighting System',
  RVR: 'Runway Visual Range',
  LGT: 'Lighting',
  LGTS: 'Lighting',
  AD: 'Aerodrome',
  OBST: 'Obstacle',
  CRANE: 'Crane',
  GLD: 'Glider',
  SID: 'Standard Instrument Departure',
  STAR: 'Standard Terminal Arrival Route',
  IAP: 'Instrument Approach Procedure',
  FATO: 'Final Approach and Takeoff Area (helicopter)',
  HEL: 'Helicopter',
  APRON: 'Apron',
  GATE: 'Gate',
  STAND: 'Aircraft stand',
  FREQ: 'Frequency',
  ATIS: 'Automatic Terminal Information Service',
  ATC: 'Air Traffic Control',
  CTR: 'Control zone',
  TMA: 'Terminal control area',
  FIR: 'Flight Information Region',

  // Conditions and timing.
  PPR: 'Prior permission required',
  'O/R': 'On request',
  H24: 'Continuously, 24 hours',
  DAILY: 'Daily',
  PERM: 'Permanent',
  TEMPO: 'Temporary',
  WEF: 'With effect from',
  TIL: 'Until',
  PSN: 'Position',
  SFC: 'Surface',
  UNL: 'Unlimited',
  AMSL: 'Above mean sea level',
  AGL: 'Above ground level',
  FL: 'Flight level',
  NM: 'Nautical miles'
};

/** Decodes one NOTAM abbreviation. */
export function decodeNotamToken(token) {
  const code = bare(token);
  return code ? NOTAM_WORDS[code] || null : null;
}

/** Single entry point the renderers use, so they do not need to know which
 *  dictionary a chapter's text belongs to beyond its own kind. */
export function decodeToken(kind, token) {
  return kind === 'notam' ? decodeNotamToken(token) : decodeWxToken(token);
}
