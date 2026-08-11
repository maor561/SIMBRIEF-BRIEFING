/**
 * The flight as it actually runs, against the flight as it was planned.
 *
 * An OFP is written before anything happens, so every time in it is a
 * prediction anchored to a scheduled departure. The moment a flight goes late
 * -- and they mostly do -- every downstream figure on every screen is quietly
 * wrong, including the waypoint times a crew would check fuel against.
 *
 * This tracks the turnaround as a chain of phases, each timed, each closed by
 * hand. Completing the takeoff phase stamps the real wheels-up time, and from
 * that instant the whole chain is recomputed from the OFP's own intervals:
 *
 *   landing    = takeoff + enroute time
 *   on-blocks  = landing + taxi in
 *   each fix   = takeoff + that fix's cumulative time
 *
 * The planned times are never overwritten -- they stay alongside, because the
 * gap between them is the delay, and that is worth seeing.
 */

const STORE_KEY = 'sbb.timeline';

/**
 * The two moments that carry a real anchor into the OFP's clock.
 *
 * Each is a single stamp, not a span with a start and an end. Wheels-up is an
 * instant, and asking a crew to open a timer before it and close it after
 * puts a step between pressing takeoff and the times updating -- which is the
 * only thing pressing it is for.
 *
 * Nothing else is tracked. Ground handling has no bearing on any figure in
 * the briefing: knowing how long boarding took changes no fuel number and no
 * waypoint time.
 */
export const PHASES = [
  // Stamping this rebuilds the entire clock.
  { key: 'takeoff', labelKey: 'phase.takeoff', anchor: 'off' },
  { key: 'landing', labelKey: 'phase.landing', anchor: 'on' }
];

export const PHASE_KEYS = PHASES.map((p) => p.key);

export function phaseFor(key) {
  return PHASES.find((p) => p.key === key) || null;
}

/* ------------------------------------------------------------------ store */

/** Distinguishes one OFP from the next, so a new plan starts clean. */
function flightKey(model) {
  const stamp = model.generatedAt instanceof Date ? model.generatedAt.getTime() : model.generatedAt;
  return `${model.flight.callsign || model.flight.number || 'FLT'}-${stamp || 0}`;
}

function read() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}

function write(data) {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* storage disabled; the timeline simply does not survive a reload */
  }
}

const EMPTY = { phases: {}, current: null };

/** The timeline for this flight, or a clean one if none has been started. */
export function getTimeline(model) {
  const store = read();
  if (store.key !== flightKey(model) || !store.timeline) return { ...EMPTY };
  return { ...EMPTY, ...store.timeline };
}

function save(model, timeline) {
  write({ key: flightKey(model), timeline });
  return timeline;
}

export function resetTimeline(model) {
  return save(model, { ...EMPTY });
}

/* ---------------------------------------------------------------- driving */

/**
 * Records that a moment has just happened. One press, one stamp -- pressing
 * takeoff is what rebases the clock, with nothing in between.
 */
export function stampPhase(model, key, at = Date.now()) {
  if (!phaseFor(key)) return getTimeline(model);

  const timeline = getTimeline(model);
  timeline.phases = { ...timeline.phases, [key]: { at } };
  timeline.current = key;
  return save(model, timeline);
}

/** Takes a stamp back, for the mis-tap. */
export function clearPhase(model, key) {
  const timeline = getTimeline(model);
  if (!timeline.phases[key]) return timeline;

  timeline.phases = { ...timeline.phases };
  delete timeline.phases[key];

  // Touchdown cannot stand without a takeoff to have flown from.
  if (key === 'takeoff') delete timeline.phases.landing;

  timeline.current = PHASE_KEYS.filter((k) => timeline.phases[k]).pop() || null;
  return save(model, timeline);
}

/* ---------------------------------------------------------------- reading */

/**
 * The instant a phase was stamped at.
 *
 * Also reads the older shape, where each phase was a span with a start and an
 * end: a timeline already in progress on a tablet should survive the change
 * rather than losing the takeoff time it was built on.
 */
function stampOf(timeline, key) {
  const entry = timeline?.phases?.[key];
  if (!entry) return null;
  const at = entry.at ?? entry.endedAt;
  return Number.isFinite(at) ? at : null;
}

export function phaseState(timeline, key) {
  return stampOf(timeline, key) === null ? 'pending' : 'done';
}

/**
 * How long ago a moment was. For takeoff that is the time airborne, and it
 * stops counting at touchdown -- after landing the useful figure is how long
 * the flight took, not how long ago it ended.
 */
export function phaseElapsed(timeline, key, now = Date.now()) {
  const at = stampOf(timeline, key);
  if (at === null) return null;

  const until = key === 'takeoff' ? stampOf(timeline, 'landing') ?? now : now;
  return Math.max(0, Math.round((until - at) / 1000));
}

/** When the aircraft actually left the ground, if the crew has said so. */
export function actualOff(timeline) {
  const at = stampOf(timeline, 'takeoff');
  return at === null ? null : new Date(at);
}

/** When it actually touched down. */
export function actualOn(timeline) {
  const at = stampOf(timeline, 'landing');
  return at === null ? null : new Date(at);
}

/**
 * The flight's clock, planned and -- once takeoff is stamped -- actual.
 *
 * Landing is the measured time if it has been marked, otherwise the takeoff
 * time plus the planned enroute time. Both are worth having: before touchdown
 * the projection is the useful number, after it the fact is.
 */
export function rebasedTimes(model, timeline) {
  const times = model.times;
  const off = actualOff(timeline);
  const planned = {
    off: times.estOff || times.schedOff || null,
    on: times.estOn || times.schedOn || null,
    in: times.estIn || times.schedIn || null
  };

  if (!off) return { started: false, planned, actual: null, delaySeconds: null };

  const onMeasured = actualOn(timeline);
  const on = onMeasured || addSeconds(off, times.estTimeEnroute);
  const inBlocks = on ? addSeconds(on, times.taxiIn) : null;

  return {
    started: true,
    planned,
    actual: { off, on, in: inBlocks, onIsMeasured: Boolean(onMeasured) },
    // How far off the plan the flight actually went, in seconds. Positive is
    // late, which is the usual direction.
    delaySeconds: planned.off ? Math.round((off.getTime() - planned.off.getTime()) / 1000) : null
  };
}

function addSeconds(date, seconds) {
  if (!date || !Number.isFinite(seconds)) return null;
  return new Date(date.getTime() + seconds * 1000);
}

/**
 * When the aircraft is expected over a fix, on the real clock.
 *
 * Falls back to the planned takeoff time before START, so the navlog reads in
 * wall-clock terms from the outset rather than only once airborne.
 */
export function fixEta(model, timeline, fix) {
  if (!Number.isFinite(fix?.timeTotal)) return null;
  const off = actualOff(timeline) || model.times.estOff || model.times.schedOff;
  return off ? addSeconds(off instanceof Date ? off : new Date(off), fix.timeTotal) : null;
}

/* ---------------------------------------------------------------- alerts */

/**
 * The moments worth interrupting for, each with the time it happens at.
 *
 * Two kinds. Before departure they come from the plan: the scheduled and
 * estimated off-blocks, and the estimated wheels-up. After takeoff they come
 * from the rebased clock, and the one that matters is the top of descent --
 * the point the aircraft stops being able to loiter over its options.
 *
 * Departure alerts stop once the aircraft is airborne: nobody needs telling
 * about the estimated takeoff time after taking off.
 */
export function alertPoints(model, timeline) {
  const off = actualOff(timeline);
  const points = [];

  if (!off) {
    const { schedOut, estOut, estOff } = model.times;
    if (schedOut) points.push({ key: 'std', at: schedOut, lead: 15 * 60 });
    // Only worth its own alert when it differs from the scheduled time.
    if (estOut && (!schedOut || Math.abs(estOut - schedOut) > 60)) {
      points.push({ key: 'etd', at: estOut, lead: 10 * 60 });
    }
    if (estOff) points.push({ key: 'etot', at: estOff, lead: 10 * 60 });
    return points;
  }

  const descent = model.navlog.find((f) => f.stage === 'DSC' || f.stage === 'DES');
  if (descent && Number.isFinite(descent.timeTotal)) {
    points.push({
      key: 'tod',
      at: new Date(off.getTime() + descent.timeTotal * 1000),
      lead: 10 * 60,
      fix: descent
    });
  }

  return points;
}

/**
 * The alert that is due but has not been shown yet.
 *
 * "Due" means inside its lead time and not yet past -- an alert for a moment
 * that has already gone by is noise, so each one expires two minutes after its
 * time rather than waiting to be acknowledged.
 */
export function dueAlert(model, timeline, seen = new Set(), now = Date.now()) {
  for (const point of alertPoints(model, timeline)) {
    const at = point.at instanceof Date ? point.at.getTime() : new Date(point.at).getTime();
    if (!Number.isFinite(at) || seen.has(point.key)) continue;

    const secondsAway = Math.round((at - now) / 1000);
    if (secondsAway <= point.lead && secondsAway > -120) {
      return { ...point, at: new Date(at), secondsAway };
    }
  }
  return null;
}

/* ------------------------------------------------------- prompt cadence */

const MODE_KEY = 'sbb.fuelPromptMode';

/** 'key' asks at the points that carry information; 'all' at every fix. */
export function getPromptMode() {
  try {
    return globalThis.localStorage?.getItem(MODE_KEY) === 'all' ? 'all' : 'key';
  } catch {
    return 'key';
  }
}

export function setPromptMode(mode) {
  try {
    globalThis.localStorage?.setItem(MODE_KEY, mode === 'all' ? 'all' : 'key');
  } catch {
    /* storage disabled; the choice lasts the session only */
  }
  return getPromptMode();
}

/**
 * The fixes worth stopping at to log the fuel on board.
 *
 * By default not every waypoint: this flight has thirty-two, and a prompt at
 * each one becomes something to dismiss rather than something to read. The
 * points that carry information are the top of climb (where the climb burn is
 * finally known), each hour of cruise (where a trend shows), the top of
 * descent (the last point a diversion is cheap) and the destination.
 *
 * A crew that wants the full log can have it: 'all' mode returns every fix.
 */
export function fuelCheckpoints(model, mode = getPromptMode()) {
  const fixes = model.navlog.filter((f) => Number.isFinite(f.timeTotal));
  if (!fixes.length) return [];

  if (mode === 'all') {
    return fixes
      .filter((fix) => Number.isFinite(fix.fuelOnBoard))
      .map((fix) => ({ fix, why: 'fix' }));
  }

  const chosen = new Map();
  const take = (fix, why) => {
    if (fix && !chosen.has(fix.index)) chosen.set(fix.index, { fix, why });
  };

  const topOfClimb = fixes.find((f) => f.stage === 'CRZ');
  // SimBrief spells descent 'DSC'; accept 'DES' too rather than depend on it.
  const topOfDescent = fixes.find((f) => f.stage === 'DSC' || f.stage === 'DES');

  take(topOfClimb, 'toc');

  if (topOfClimb) {
    // Stop short of the descent point: an hourly check twenty minutes before
    // one that is about to happen anyway is a prompt with nothing to add.
    const end = topOfDescent ? topOfDescent.timeTotal : fixes[fixes.length - 1].timeTotal;
    const until = end - 20 * 60;
    for (let at = topOfClimb.timeTotal + 3600; at < until; at += 3600) {
      take(nearestFix(fixes, at), 'cruise');
    }
  }

  take(topOfDescent, 'tod');
  take(fixes[fixes.length - 1], 'destination');

  return [...chosen.values()].sort((a, b) => a.fix.timeTotal - b.fix.timeTotal);
}

/** The fix closest in time to a given point in the flight. */
function nearestFix(fixes, seconds) {
  let best = null;
  let bestGap = Infinity;
  for (const fix of fixes) {
    const gap = Math.abs(fix.timeTotal - seconds);
    if (gap < bestGap) {
      bestGap = gap;
      best = fix;
    }
  }
  return best;
}

/**
 * The checkpoint the flight has reached but has no reading for yet -- what a
 * prompt should be asking about. Null until takeoff is stamped, and null once
 * everything due has been answered.
 */
export function dueCheckpoint(model, timeline, actuals, now = Date.now(), mode = getPromptMode()) {
  const off = actualOff(timeline);
  if (!off) return null;

  const elapsed = (now - off.getTime()) / 1000;
  const reached = fuelCheckpoints(model, mode).filter((c) => c.fix.timeTotal <= elapsed);

  // Oldest unanswered first: falling behind should not skip the earlier one.
  return reached.find(({ fix }) => !Number.isFinite(actuals[fix.index])) || null;
}

/**
 * What a diversion would leave in the tanks, decided from where the aircraft
 * actually is.
 *
 * The alternate's burn and the final reserve are both in the plan; what is
 * missing in the air is the fuel on board *now*. That comes from the last
 * logged reading when there is one, and from the plan at the current position
 * when there is not -- and which of the two it used is reported, because a
 * figure derived from the plan is a prediction, not a measurement.
 *
 * The margin is what is left after landing at the alternate with the reserve
 * still intact. Once it goes negative the diversion no longer closes, which is
 * the moment worth seeing coming.
 */
export function diversionNow(model, timeline, actuals = {}, now = Date.now()) {
  const alternate = model.alternates[0];
  if (!alternate || !Number.isFinite(alternate.burn)) return null;

  const reserve = model.fuel.reserve ?? 0;
  const required = alternate.burn + reserve;

  const logged = model.navlog.filter((f) => Number.isFinite(actuals[f.index]));
  const leg = currentLeg(model, timeline, now);

  let onBoard = null;
  let source = null;

  if (logged.length) {
    onBoard = actuals[logged[logged.length - 1].index];
    source = 'logged';
  } else if (leg?.passed && Number.isFinite(leg.passed.fuelOnBoard)) {
    onBoard = leg.passed.fuelOnBoard;
    source = 'planned';
  } else if (Number.isFinite(model.fuel.planTakeoff)) {
    onBoard = model.fuel.planTakeoff;
    source = 'planned';
  }

  if (!Number.isFinite(onBoard)) return null;

  return {
    icao: alternate.icao,
    distance: alternate.distance,
    burn: alternate.burn,
    reserve,
    required,
    onBoard,
    source,
    // What would remain on the ground at the alternate.
    landingWith: onBoard - alternate.burn,
    // What is left over and above the reserve.
    margin: onBoard - required,
    viable: onBoard - required >= 0
  };
}

/**
 * Which leg the flight is on right now: the last fix already passed and the
 * one being flown towards. Null until takeoff is stamped, since before that
 * there is no real clock to place the aircraft on.
 */
export function currentLeg(model, timeline, now = Date.now()) {
  const off = actualOff(timeline);
  if (!off || !model.navlog.length) return null;

  const elapsed = (now - off.getTime()) / 1000;
  if (elapsed < 0) return null;

  let passed = null;
  for (const fix of model.navlog) {
    if (Number.isFinite(fix.timeTotal) && fix.timeTotal <= elapsed) passed = fix;
    else break;
  }

  const next = model.navlog.find((f) => Number.isFinite(f.timeTotal) && f.timeTotal > elapsed) || null;
  return { passed, next, elapsed: Math.round(elapsed) };
}
