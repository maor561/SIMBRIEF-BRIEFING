/**
 * Turns a raw SimBrief OFP into a clean model for the views.
 *
 * Everything SimBrief returns is a string, optional nodes come back as empty
 * strings, and repeated nodes are sometimes objects and sometimes arrays. All
 * of that is dealt with here so no view has to.
 */

/**
 * True when SimBrief means "this field is empty".
 *
 * The two sources disagree: the XML export writes an empty element, which
 * converts to "", while the live JSON API returns an empty object {}. Both mean
 * absent, and stringifying the latter yields "[object Object]" in the UI.
 */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return String(value).trim() === '';
}

/** Numeric field -> number, or null when SimBrief left it blank. */
export function num(value) {
  if (isBlank(value) || typeof value === 'object') return null;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Text field -> trimmed string, or null when blank. */
export function str(value) {
  if (isBlank(value) || typeof value === 'object') return null;
  return String(value).trim();
}

/** Truthy flag -> boolean. Blank and empty-object values are false. */
export function flag(value) {
  if (isBlank(value)) return false;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

/** Anything -> array. Blank nodes and empty objects become []. */
export function arr(value) {
  if (Array.isArray(value)) return value.filter((item) => !isBlank(item));
  if (isBlank(value)) return [];
  return [value];
}

/** SimBrief unix seconds -> Date. */
function epoch(value) {
  const seconds = num(value);
  return seconds ? new Date(seconds * 1000) : null;
}

function normalizeAtis(entry) {
  return {
    source: str(entry.network) || str(entry.source) || null,
    issued: str(entry.datetime) || str(entry.time) || null,
    letter: str(entry.letter) || str(entry.code) || null,
    type: str(entry.type) || null,
    text: str(entry.text) || str(entry.message) || null
  };
}

function normalizeNotam(entry) {
  return {
    id: str(entry.notam_id),
    location: str(entry.location_icao) || str(entry.location_id) || str(entry.icao_id),
    locationName: str(entry.location_name) || str(entry.icao_name),
    locationType: str(entry.location_type),
    effective: str(entry.date_effective) || parseNotamDtg(entry.notam_effective_dtg),
    expires: str(entry.date_expire) || parseNotamDtg(entry.notam_expire_dtg_estimated),
    expiryEstimated: flag(entry.date_expire_is_estimated),
    created: str(entry.date_created),
    schedule: str(entry.notam_schedule),
    html: str(entry.notam_html),
    text: str(entry.notam_text) || str(entry.notam_report),
    raw: str(entry.notam_raw) || str(entry.notam_text),
    qcode: str(entry.notam_qcode),
    // SimBrief decodes the ICAO Q-code for us, which is far more reliable than
    // us re-deriving subject/status from the raw code.
    subject: str(entry.notam_qcode_subject),
    status: str(entry.notam_qcode_status),
    category: str(entry.notam_qcode_category),
    isObstacle: flag(entry.notam_is_obstacle)
  };
}

/** Enroute NOTAMs use compact YYYYMMDDHHMM stamps instead of ISO. */
function parseNotamDtg(value) {
  const text = str(value);
  if (!text || !/^\d{12}$/.test(text)) return null;
  const [, y, mo, d, h, mi] = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return `${y}-${mo}-${d}T${h}:${mi}:00Z`;
}

function normalizeAirport(node, role) {
  if (!node) return null;
  return {
    role,
    icao: str(node.icao_code),
    iata: str(node.iata_code),
    name: str(node.name),
    elevation: num(node.elevation),
    lat: num(node.pos_lat),
    lon: num(node.pos_long),
    timezone: num(node.timezone),
    plannedRunway: str(node.plan_rwy),
    transAlt: num(node.trans_alt),
    transLevel: num(node.trans_level),
    metar: str(node.metar),
    metarTime: str(node.metar_time),
    metarCategory: (str(node.metar_category) || '').toLowerCase() || null,
    metarVisibility: num(node.metar_visibility),
    metarCeiling: num(node.metar_ceiling),
    taf: str(node.taf),
    tafTime: str(node.taf_time),
    atis: arr(node.atis).map(normalizeAtis).filter((a) => a.text),
    notams: arr(node.notam).map(normalizeNotam),

    // Alternate-only planning fields.
    distance: num(node.distance),
    ete: num(node.ete),
    burn: num(node.burn),
    route: str(node.route),
    cruiseAltitude: num(node.cruise_altitude),
    avgWindDir: num(node.avg_wind_dir),
    avgWindSpd: num(node.avg_wind_spd)
  };
}

function normalizeFix(node, index) {
  return {
    index,
    ident: str(node.ident),
    name: str(node.name),
    type: str(node.type),
    stage: str(node.stage),
    via: str(node.via_airway),
    isSidStar: flag(node.is_sid_star),
    lat: num(node.pos_lat),
    lon: num(node.pos_long),
    distance: num(node.distance),
    altitude: num(node.altitude_feet),
    ias: num(node.ind_airspeed),
    tas: num(node.true_airspeed),
    mach: num(node.mach),
    groundspeed: num(node.groundspeed),
    windDir: num(node.wind_dir),
    windSpd: num(node.wind_spd),
    windComponent: num(node.wind_component),
    shear: num(node.shear),
    oat: num(node.oat),
    isaDev: num(node.oat_isa_dev),
    tropopause: num(node.tropopause_feet),
    mora: num(node.mora),
    groundHeight: num(node.ground_height),
    fir: str(node.fir),
    timeLeg: num(node.time_leg),
    timeTotal: num(node.time_total),
    fuelLeg: num(node.fuel_leg),
    fuelUsed: num(node.fuel_totalused),
    fuelOnBoard: num(node.fuel_plan_onboard),
    fuelMinOnBoard: num(node.fuel_min_onboard),
    trackMag: num(node.track_mag),
    headingMag: num(node.heading_mag)
  };
}

function normalizeRunway(node) {
  return {
    identifier: str(node.identifier),
    length: num(node.length),
    tora: num(node.length_tora),
    toda: num(node.length_toda),
    asda: num(node.length_asda),
    lda: num(node.length_lda),
    elevation: num(node.elevation),
    gradient: num(node.gradient),
    trueCourse: num(node.true_course),
    magneticCourse: num(node.magnetic_course),
    headwind: num(node.headwind_component),
    crosswind: num(node.crosswind_component),
    ils: str(node.ils_frequency),
    flap: str(node.flap_setting),
    thrust: str(node.thrust_setting),
    bleed: str(node.bleed_setting),
    antiIce: str(node.anti_ice_setting),
    flexTemp: num(node.flex_temperature),
    maxTemp: num(node.max_temperature),
    maxWeight: num(node.max_weight),
    maxWeightDry: num(node.max_weight_dry),
    maxWeightWet: num(node.max_weight_wet),
    limitCode: str(node.limit_code),
    limitObstacle: str(node.limit_obstacle),
    v1: num(node.speeds_v1),
    vr: num(node.speeds_vr),
    v2: num(node.speeds_v2),
    vref: num(node.speeds_other),
    vrefId: str(node.speeds_other_id),
    distanceDecide: num(node.distance_decide),
    distanceReject: num(node.distance_reject),
    distanceMargin: num(node.distance_margin),
    distanceContinue: num(node.distance_continue)
  };
}

function normalizeTlrSide(node) {
  if (!node || typeof node !== 'object') return null;
  const conditions = node.conditions || {};
  return {
    airport: str(conditions.airport_icao),
    plannedRunway: str(conditions.planned_runway),
    plannedWeight: num(conditions.planned_weight),
    windDir: num(conditions.wind_direction),
    windSpd: num(conditions.wind_speed),
    temperature: num(conditions.temperature),
    altimeter: num(conditions.altimeter),
    surface: str(conditions.surface_condition),
    flap: str(conditions.flap_setting),
    runways: arr(node.runway).map(normalizeRunway)
  };
}

/** Parses "LEBL/0320/OSPOK/0330/ORKUM/0320" into ordered steps. */
function parseStepClimb(value) {
  const text = str(value);
  if (!text) return [];
  const parts = text.split('/');
  const steps = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const level = num(parts[i + 1]);
    steps.push({ ident: parts[i].trim(), flightLevel: level ? Math.round(level / 10) * 10 : null });
  }
  return steps;
}

function normalizeImages(node) {
  const directory = str(node?.directory) || '';
  const maps = arr(node?.map).map((m) => ({
    name: str(m.name) || '',
    url: directory + (str(m.link) || '')
  }));

  const find = (pattern) => maps.find((m) => pattern.test(m.name))?.url || null;

  return {
    all: maps,
    route: find(/^route/i),
    sigwx: find(/sigwx/i),
    profile: find(/vertical profile/i),
    // Winds-aloft charts are named "UAD n of m"; the level lives in the filename.
    winds: maps
      .filter((m) => /winds/i.test(m.url))
      .map((m) => ({
        url: m.url,
        level: num((m.url.match(/WINDS(\d+)/i) || [])[1])
      }))
      .sort((a, b) => (a.level || 0) - (b.level || 0))
  };
}

function normalizeImpact(node) {
  if (!node || typeof node !== 'object') return null;
  return {
    timeEnroute: num(node.time_enroute),
    timeDifference: num(node.time_difference),
    enrouteBurn: num(node.enroute_burn),
    burnDifference: num(node.burn_difference),
    rampFuel: num(node.ramp_fuel),
    initialFl: num(node.initial_fl),
    costIndex: num(node.cost_index)
  };
}

export function normalizeOfp(raw) {
  if (!raw || !raw.general) {
    throw new Error('Unrecognised OFP payload');
  }

  const general = raw.general;
  const params = raw.params || {};
  const times = raw.times || {};
  const fuel = raw.fuel || {};
  const weights = raw.weights || {};

  const fixes = arr(raw.navlog?.fix).map(normalizeFix);

  const model = {
    raw,
    units: str(params.units) === 'lbs' ? 'lbs' : 'kgs',
    airac: str(params.airac),
    layout: str(params.ofp_layout),
    generatedAt: epoch(params.time_generated),

    flight: {
      airline: str(general.icao_airline),
      number: str(general.flight_number),
      callsign: str(raw.atc?.callsign) || `${str(general.icao_airline) || ''}${str(general.flight_number) || ''}`,
      aircraft: str(raw.aircraft?.name) || str(raw.aircraft?.icao_code),
      aircraftIcao: str(raw.aircraft?.icao_code),
      registration: str(raw.aircraft?.reg),
      engines: str(raw.aircraft?.engines),
      isEtops: flag(general.is_etops),
      costIndex: num(general.costindex),
      climbProfile: str(general.climb_profile),
      cruiseProfile: str(general.cruise_profile),
      descentProfile: str(general.descent_profile),
      initialAltitude: num(general.initial_altitude),
      stepClimb: parseStepClimb(general.stepclimb_string),
      cruiseMach: str(general.cruise_mach),
      cruiseTas: num(general.cruise_tas),
      avgWindComponent: num(general.avg_wind_comp),
      avgTempDev: num(general.avg_temp_dev),
      avgTropopause: num(general.avg_tropopause),
      contingencyRule: str(general.cont_rule)
    },

    route: {
      text: str(general.route),
      ifps: str(general.route_ifps),
      sid: str(general.sid_ident),
      sidTrans: str(general.sid_trans),
      star: str(general.star_ident),
      starTrans: str(general.star_trans),
      distance: num(general.route_distance),
      gcDistance: num(general.gc_distance),
      airDistance: num(general.air_distance),
      firs: arr(raw.atc?.fir_enroute).map(str).filter(Boolean),
      flightplanText: str(raw.atc?.flightplan_text),
      section18: str(raw.atc?.section18)
    },

    origin: normalizeAirport(raw.origin, 'origin'),
    destination: normalizeAirport(raw.destination, 'destination'),
    alternates: arr(raw.alternate)
      .map((a) => normalizeAirport(a, 'alternate'))
      .filter((a) => a?.icao),

    navlog: fixes,

    fuel: {
      taxi: num(fuel.taxi),
      enrouteBurn: num(fuel.enroute_burn),
      contingency: num(fuel.contingency),
      alternateBurn: num(fuel.alternate_burn),
      reserve: num(fuel.reserve),
      etops: num(fuel.etops),
      extra: num(fuel.extra),
      minTakeoff: num(fuel.min_takeoff),
      planTakeoff: num(fuel.plan_takeoff),
      planRamp: num(fuel.plan_ramp),
      planLanding: num(fuel.plan_landing),
      avgFlow: num(fuel.avg_fuel_flow),
      maxTanks: num(fuel.max_tanks)
    },

    times: {
      estTimeEnroute: num(times.est_time_enroute),
      schedTimeEnroute: num(times.sched_time_enroute),
      schedOut: epoch(times.sched_out),
      schedOff: epoch(times.sched_off),
      schedOn: epoch(times.sched_on),
      schedIn: epoch(times.sched_in),
      estOut: epoch(times.est_out),
      estOff: epoch(times.est_off),
      estOn: epoch(times.est_on),
      estIn: epoch(times.est_in),
      estBlock: num(times.est_block),
      schedBlock: num(times.sched_block),
      taxiOut: num(times.taxi_out),
      taxiIn: num(times.taxi_in),
      reserveTime: num(times.reserve_time),
      contingencyTime: num(times.contfuel_time),
      endurance: num(times.endurance),
      originTimezone: num(times.orig_timezone),
      destTimezone: num(times.dest_timezone)
    },

    weights: {
      oew: num(weights.oew),
      paxCount: num(weights.pax_count_actual) ?? num(weights.pax_count),
      bagCount: num(weights.bag_count_actual) ?? num(weights.bag_count),
      paxWeight: num(weights.pax_weight),
      bagWeight: num(weights.bag_weight),
      cargo: num(weights.cargo),
      payload: num(weights.payload),
      estZfw: num(weights.est_zfw),
      maxZfw: num(weights.max_zfw),
      estTow: num(weights.est_tow),
      maxTow: num(weights.max_tow),
      maxTowStruct: num(weights.max_tow_struct),
      towLimitCode: str(weights.tow_limit_code),
      estLdw: num(weights.est_ldw),
      maxLdw: num(weights.max_ldw),
      estRamp: num(weights.est_ramp)
    },

    tlr: {
      takeoff: normalizeTlrSide(raw.tlr?.takeoff),
      landing: normalizeTlrSide(raw.tlr?.landing)
    },

    impacts: {
      minus6000: normalizeImpact(raw.impacts?.minus_6000ft),
      minus4000: normalizeImpact(raw.impacts?.minus_4000ft),
      minus2000: normalizeImpact(raw.impacts?.minus_2000ft),
      plus2000: normalizeImpact(raw.impacts?.plus_2000ft),
      plus4000: normalizeImpact(raw.impacts?.plus_4000ft),
      plus6000: normalizeImpact(raw.impacts?.plus_6000ft),
      higherCi: normalizeImpact(raw.impacts?.higher_ci),
      lowerCi: normalizeImpact(raw.impacts?.lower_ci),
      zfwPlus1000: normalizeImpact(raw.impacts?.zfw_plus_1000),
      zfwMinus1000: normalizeImpact(raw.impacts?.zfw_minus_1000)
    },

    images: normalizeImages(raw.images),
    enrouteNotams: arr(raw.notams?.notamdrec).map(normalizeNotam),
    sigmets: arr(raw.sigmets?.sigmet).map((s) => ({
      text: str(s?.text) || str(s),
      fir: str(s?.fir)
    })).filter((s) => s.text),

    links: {
      skyvector: str(raw.links?.skyvector) || str(raw.links),
      map: str(raw.map_data)
    }
  };

  // Convenience slices the phase views lean on. SimBrief writes the descent
  // stage as DSC; DES is accepted too in case a layout differs.
  model.phases = {
    climb: fixes.filter((f) => f.stage === 'CLB'),
    cruise: fixes.filter((f) => f.stage === 'CRZ'),
    descent: fixes.filter((f) => f.stage === 'DSC' || f.stage === 'DES')
  };

  // SimBrief inserts explicit TOC/TOD pseudo-fixes. They are the real phase
  // boundaries: TOD still carries the CRZ stage but is where descent starts.
  model.topOfClimb = fixes.find((f) => f.ident === 'TOC') || model.phases.cruise[0] || null;
  model.topOfDescent = fixes.find((f) => f.ident === 'TOD') || model.phases.descent[0] || null;

  return model;
}
