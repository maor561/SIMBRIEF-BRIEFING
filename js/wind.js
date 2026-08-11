/**
 * Wind components against a runway.
 *
 * SimBrief computes headwind and crosswind once, from the wind it had when the
 * plan was built. That figure is what the takeoff numbers assume. Hours later
 * the wind has usually moved, and the difference is the whole point of pulling
 * a live METAR: a runway planned with 9 kt of crosswind and now blowing 25 is
 * a different takeoff, and nothing in the OFP will say so.
 *
 * Runway courses in the OFP come as both true and magnetic. METAR surface wind
 * is reported in degrees true, so `trueCourse` is the one to resolve against --
 * mixing it with the magnetic course would bake in the local variation as an
 * error.
 */

import { windComponents } from './decode.js';

/**
 * The components a crew would actually brief from one METAR.
 *
 * Two refinements on the raw resolve, both of them standard practice:
 *
 *   gust      crosswind is assessed against the gust, not the mean, since the
 *             gust is what the aircraft has to be flown through.
 *   variable  a wind reported as varying across an arc (`060V150`) can sit
 *             anywhere in it, so the arc is swept and the worst crosswind and
 *             worst tailwind in it are reported alongside the mean.
 *
 * A wind with no direction -- VRB, or calm -- cannot be resolved onto a
 * runway at all. That returns `variable: true` with no components rather than
 * a fabricated number.
 */
export function runwayWind(runway, metar) {
  const course = runway?.trueCourse;
  const wind = metar?.wind;
  if (!Number.isFinite(course) || !wind) return null;

  if (wind.calm) return { calm: true, speed: 0, direction: null };
  if (!Number.isFinite(wind.direction)) {
    return { variable: true, speed: wind.speed ?? null, direction: null };
  }

  const mean = windComponents(wind.direction, wind.speed, course);
  if (!mean) return null;

  const gust = Number.isFinite(wind.gust) ? windComponents(wind.direction, wind.gust, course) : null;
  const arc = sweepArc(course, wind, gust ? wind.gust : wind.speed);

  return {
    direction: wind.direction,
    speed: wind.speed,
    gustSpeed: wind.gust ?? null,
    headwind: mean.headwind,
    crosswind: mean.crosswind,
    fromLeft: mean.fromLeft,
    gust,
    arc,
    // What the crew has to be able to handle: the gust across the widest the
    // wind is allowed to sit.
    worstCrosswind: Math.max(mean.crosswind, gust?.crosswind ?? 0, arc?.crosswind ?? 0),
    // Zero floors it: a headwind everywhere in the arc means no tailwind case.
    worstTailwind: Math.max(0, -mean.headwind, gust ? -gust.headwind : 0, arc ? -arc.headwind : 0)
  };
}

/**
 * Walks a variable-wind arc a degree at a time and keeps the worst case. The
 * arc is short and this runs once per runway, so stepping it is cheaper to
 * read than solving for the extremes.
 */
function sweepArc(course, wind, speed) {
  const { varyFrom, varyTo } = wind;
  if (!Number.isFinite(varyFrom) || !Number.isFinite(varyTo) || !Number.isFinite(speed)) return null;

  const span = (varyTo - varyFrom + 360) % 360;
  let crosswind = 0;
  let headwind = Infinity;

  for (let step = 0; step <= span; step += 1) {
    const resolved = windComponents((varyFrom + step) % 360, speed, course);
    if (!resolved) continue;
    crosswind = Math.max(crosswind, resolved.crosswind);
    headwind = Math.min(headwind, resolved.headwind);
  }

  if (!Number.isFinite(headwind)) return null;
  return { from: varyFrom, to: varyTo, crosswind, headwind };
}
