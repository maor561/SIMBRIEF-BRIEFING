/**
 * Plan-versus-actual fuel log.
 *
 * The crew types the fuel actually on board as each fix goes by; this keeps
 * those readings and judges them against the OFP's own numbers. Entries are
 * held per flight so reloading the page does not lose them, and a different
 * OFP starts clean rather than inheriting the last flight's readings.
 *
 * Thresholds come from the plan itself rather than an invented constant:
 * contingency fuel is exactly the margin the dispatcher set aside for burning
 * more than forecast, so spending more than that is the point where the plan
 * stops covering the difference.
 */

const STORE_KEY = 'sbb.fuelLog';

/** Distinguishes one OFP from the next, so readings never cross flights. */
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
    /* storage disabled; readings simply do not survive the session */
  }
}

/** Every reading logged for this flight, keyed by navlog fix index. */
export function getActuals(model) {
  const store = read();
  const key = flightKey(model);
  return store.key === key && store.values ? store.values : {};
}

export function setActual(model, fixIndex, value) {
  const key = flightKey(model);
  const store = read();
  const values = store.key === key && store.values ? store.values : {};

  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
    delete values[fixIndex];
  } else {
    values[fixIndex] = Number(value);
  }

  write({ key, values });
  return values;
}

export function clearActuals(model) {
  write({ key: flightKey(model), values: {} });
}

/**
 * How one reading compares to the plan.
 *
 * `diff` is actual minus planned, so negative means burning faster than
 * forecast. Below the fix's own minimum-on-board is the serious one -- that
 * is the figure that already accounts for reserve and alternate.
 *
 * Checked before any of that: whether the reading is even physically
 * possible. A fat-fingered entry (one digit too many, a stray leading digit)
 * lands inside the aircraft's real range often enough that `diff` alone
 * would just read as an ordinary burn -- onPlan or under, never flagged.
 * `maxOnBoard` is the fuel actually loaded at the ramp, the most any reading
 * during this flight could honestly be; nothing can be negative either.
 */
export function classify(fix, actual, contingency, maxOnBoard) {
  if (!Number.isFinite(actual)) return { state: 'none', diff: null };

  const planned = fix.fuelOnBoard;
  const diff = Number.isFinite(planned) ? actual - planned : null;

  if (actual < 0 || (Number.isFinite(maxOnBoard) && actual > maxOnBoard)) {
    return { state: 'implausible', diff };
  }
  if (Number.isFinite(fix.fuelMinOnBoard) && actual < fix.fuelMinOnBoard) {
    return { state: 'belowMin', diff };
  }
  if (diff === null) return { state: 'none', diff: null };
  if (Number.isFinite(contingency) && contingency > 0 && diff < -contingency) {
    return { state: 'overBurn', diff };
  }
  if (diff < 0) return { state: 'under', diff };
  return { state: 'onPlan', diff };
}

/**
 * The whole flight in one verdict, driven by the worst reading logged so far.
 */
export function summarise(model, actuals) {
  const contingency = model.fuel.contingency;
  const maxOnBoard = model.fuel.planRamp;
  const entries = model.navlog
    .filter((fix) => Number.isFinite(actuals[fix.index]))
    .map((fix) => ({
      fix,
      actual: actuals[fix.index],
      ...classify(fix, actuals[fix.index], contingency, maxOnBoard)
    }));

  if (!entries.length) {
    return { count: 0, state: 'none', worst: null, latest: null, contingency };
  }

  const rank = { onPlan: 0, under: 1, overBurn: 2, belowMin: 3, implausible: 4 };
  const worst = entries.reduce((a, b) => (rank[b.state] > rank[a.state] ? b : a));
  const latest = entries[entries.length - 1];

  return { count: entries.length, state: worst.state, worst, latest, contingency };
}
