/**
 * Matches the live VATSIM controller list onto this flight's airports and FIRs.
 *
 * The logic is pure so it can be tested against a captured feed: the network
 * call lives in the view. Callsigns follow the network convention
 * `<ICAO>_<sector?>_<POSITION>` -- LEBL_TWR, LEBL_S_TWR, LECB_CTR -- so a
 * prefix match on the four-letter code finds an airport's or a centre's
 * positions including any sector split.
 *
 * A caveat worth carrying: VATSIM only publishes a frequency for a position
 * that is *staffed*. SimBrief's OFP carries no aerodrome frequencies at all,
 * so an unstaffed position can be listed but never given a number.
 */

export const FACILITY = { FSS: 1, DEL: 2, GND: 3, TWR: 4, APP: 5, CTR: 6 };

/** The tower-and-below positions a crew works through, in the order they use them. */
export const AIRPORT_POSITIONS = [
  { key: 'atis', facility: null },
  { key: 'del', facility: FACILITY.DEL },
  { key: 'gnd', facility: FACILITY.GND },
  { key: 'twr', facility: FACILITY.TWR },
  { key: 'app', facility: FACILITY.APP }
];

/**
 * Groups the feed into departure, enroute and arrival blocks.
 * `feed` may be null when the network call failed -- every position then
 * reports as unstaffed rather than the screen breaking.
 */
export function buildAtcGroups(model, feed) {
  const controllers = feed?.controllers || [];
  const atis = feed?.atis || [];

  const airport = (ap, role) =>
    ap && {
      icao: ap.icao,
      name: ap.name,
      role,
      positions: AIRPORT_POSITIONS.map((position) => ({
        key: position.key,
        stations:
          position.key === 'atis'
            ? matchPrefix(atis, ap.icao)
            : matchPrefix(controllers, ap.icao).filter((s) => s.facility === position.facility)
      }))
    };

  // Enroute centres, in the order the route crosses them.
  const enroute = uniqueFirs(model).map((fir) => ({
    fir,
    stations: matchPrefix(controllers, fir).filter(
      (s) => s.facility === FACILITY.CTR || s.facility === FACILITY.FSS
    )
  }));

  return {
    departure: airport(model.origin, 'DEP'),
    enroute,
    arrival: airport(model.destination, 'DEST'),
    alternates: model.alternates.map((a, i) =>
      airport(a, model.alternates.length > 1 ? `ALTN ${i + 1}` : 'ALTN')
    ).filter(Boolean)
  };
}

/**
 * Stations whose callsign starts with the given four-letter code. Sorted so a
 * plain position (LEBL_TWR) reads before its sector splits (LEBL_S_TWR).
 */
function matchPrefix(stations, code) {
  if (!code) return [];
  const prefix = `${code.toUpperCase()}_`;
  return stations
    .filter((s) => typeof s.callsign === 'string' && s.callsign.toUpperCase().startsWith(prefix))
    .sort((a, b) => a.callsign.length - b.callsign.length || a.callsign.localeCompare(b.callsign));
}

/** FIRs along the route, deduplicated but kept in the order they are crossed. */
function uniqueFirs(model) {
  const seen = new Set();
  const out = [];
  const push = (fir) => {
    if (!fir || seen.has(fir)) return;
    seen.add(fir);
    out.push(fir);
  };

  // The navlog crosses them in order; route.firs is the filed list and may
  // hold one the navlog never names.
  model.navlog.forEach((f) => push(f.fir));
  (model.route.firs || []).forEach(push);
  return out;
}

/** Total staffed positions across every block, for the header count. */
export function countOnline(groups) {
  const fromAirport = (a) => (a ? a.positions.reduce((n, p) => n + p.stations.length, 0) : 0);
  return (
    fromAirport(groups.departure) +
    fromAirport(groups.arrival) +
    groups.alternates.reduce((n, a) => n + fromAirport(a), 0) +
    groups.enroute.reduce((n, e) => n + e.stations.length, 0)
  );
}

/** "2h 14m" since a controller signed on. */
export function onlineFor(logonTime) {
  if (!logonTime) return null;
  const started = new Date(logonTime).getTime();
  if (Number.isNaN(started)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - started) / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
