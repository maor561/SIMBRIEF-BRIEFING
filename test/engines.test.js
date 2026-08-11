/**
 * Checks the decode and analyse engines against the saved OFP fixture.
 *
 *   node test/engines.test.js
 *
 * The fixture is a real ELY2569 LEBL->LCLK plan, so the expectations below are
 * facts about that flight, not invented numbers.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { normalizeOfp, str, num, arr, flag } from '../js/normalize.js';
import { analyze, SEVERITY, countByChapter } from '../js/analyze.js';
import {
  parseMetar,
  parseTaf,
  groupCovers,
  ceilingOf,
  windComponents,
  notamSeverity,
  mentionsRunway,
  notamActiveDuring,
  screenEnrouteNotam,
  flightCategory,
  categoryRank
} from '../js/decode.js';
import { runwayWind } from '../js/wind.js';
import { notamKey, isRead, markRead, markUnread, unreadCount } from '../js/notamlog.js';
import {
  PHASES,
  getTimeline,
  startPhase,
  completePhase,
  reopenPhase,
  phaseState,
  rebasedTimes,
  fixEta,
  currentLeg,
  fuelCheckpoints,
  dueCheckpoint
} from '../js/timeline.js';

const fixturePath = fileURLToPath(new URL('./fixture.json', import.meta.url));
const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

console.log('\nnormalize');
const model = normalizeOfp(raw);

check('identifies the flight', () => {
  assert.equal(model.flight.callsign, 'ELY2569');
  assert.equal(model.flight.aircraftIcao, 'B738');
  assert.equal(model.units, 'kgs');
});

check('resolves origin, destination and alternate', () => {
  assert.equal(model.origin.icao, 'LEBL');
  assert.equal(model.destination.icao, 'LCLK');
  assert.equal(model.alternates.length, 1);
  assert.equal(model.alternates[0].icao, 'LCPH');
  assert.equal(model.alternates[0].burn, 1203);
});

check('splits the navlog into phases', () => {
  assert.equal(model.navlog.length, 32);
  assert.ok(model.phases.climb.length > 0, 'expected climb fixes');
  assert.ok(model.phases.cruise.length > 0, 'expected cruise fixes');
  assert.ok(model.phases.descent.length > 0, 'expected descent fixes');
  assert.equal(
    model.phases.climb.length + model.phases.cruise.length + model.phases.descent.length,
    model.navlog.length
  );
});

check('finds the TOC and TOD pseudo-fixes', () => {
  assert.equal(model.topOfClimb.ident, 'TOC');
  assert.equal(model.topOfDescent.ident, 'TOD');
  // TOD is the last cruise-stage point, so it still sits at cruise level.
  assert.equal(model.topOfDescent.altitude, 35000);
  assert.ok(model.topOfDescent.index < model.phases.descent[0].index);
});

check('parses the step climb string', () => {
  assert.deepEqual(
    model.flight.stepClimb.map((s) => `${s.ident}/${s.flightLevel}`),
    ['LEBL/320', 'OSPOK/330', 'ORKUM/320', 'PNZ/330', 'ESOPO/350']
  );
});

check('builds absolute image urls', () => {
  assert.ok(model.images.profile?.startsWith('https://'), 'profile url');
  assert.ok(model.images.sigwx?.includes('SIGWX'), 'sigwx url');
  assert.equal(model.images.winds.length, 3);
  assert.deepEqual(model.images.winds.map((w) => w.level), [30000, 34000, 39000]);
});

check('normalizes takeoff and landing performance', () => {
  assert.equal(model.tlr.takeoff.plannedRunway, '24L');
  assert.equal(model.tlr.takeoff.runways.length, 6);
  assert.equal(model.tlr.landing.plannedRunway, '04');
  const rwy02 = model.tlr.takeoff.runways.find((r) => r.identifier === '02');
  assert.equal(rwy02.headwind, -11, 'runway 02 has an 11kt tailwind');
  assert.equal(rwy02.crosswind, 9);
});

check('keeps decoded notam fields', () => {
  assert.equal(model.origin.notams.length, 17);
  assert.equal(model.destination.notams.length, 11);
  assert.equal(model.enrouteNotams.length, 793);
  const first = model.origin.notams[0];
  assert.equal(first.subject, 'Taxiway');
  assert.equal(first.status, 'Closed');
  assert.ok(first.html.includes('<b>'), 'html markup preserved');
});

check('converts compact enroute notam timestamps', () => {
  const withDates = model.enrouteNotams.filter((n) => n.effective);
  assert.ok(withDates.length > 0, 'expected enroute notams with dates');
  assert.match(withDates[0].effective, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

console.log('\ndecode: METAR');

check('parses the LEBL departure METAR', () => {
  const m = parseMetar(model.origin.metar);
  assert.equal(m.station, 'LEBL');
  assert.equal(m.wind.direction, 240);
  assert.equal(m.wind.speed, 14);
  assert.equal(m.wind.gust, null);
  assert.equal(m.cavok, true);
  assert.equal(m.temperature, 15);
  assert.equal(m.dewpoint, 11);
  assert.equal(m.qnhHpa, 1023);
  assert.equal(m.trend, 'NOSIG');
  assert.deepEqual(m.unparsed, []);
});

check('parses a variable wind direction range', () => {
  const m = parseMetar(model.destination.metar);
  assert.equal(m.wind.direction, 360);
  assert.equal(m.wind.varyFrom, 330);
  assert.equal(m.wind.varyTo, 70);
});

check('handles gusts, negative temps and inHg', () => {
  const m = parseMetar('KJFK 111751Z 28018G31KT 1/2SM +TSRA BKN008 OVC015 M02/M05 A2992');
  assert.equal(m.wind.gust, 31);
  assert.equal(m.temperature, -2);
  assert.equal(m.dewpoint, -5);
  assert.equal(m.qnhInHg, 29.92);
  assert.equal(m.qnhHpa, 1013);
  assert.equal(ceilingOf(m), 800);
  assert.ok(m.weather.some((w) => w.intensity === 'heavy' && w.codes.includes('TS')));
});

check('computes head and cross wind components', () => {
  // Wind 240/14 onto runway 24 (course 240) is straight down the runway.
  const straight = windComponents(240, 14, 240);
  assert.equal(straight.headwind, 14);
  assert.equal(straight.crosswind, 0);

  const quartering = windComponents(300, 20, 240);
  assert.equal(quartering.headwind, 10);
  assert.equal(quartering.crosswind, 17);

  const behind = windComponents(60, 10, 240);
  assert.equal(behind.headwind, -10, 'wind from behind is a negative headwind');
});

console.log('\ndecode: TAF');

const taf = parseTaf(model.origin.taf, model.generatedAt);

check('splits the TAF into groups', () => {
  assert.ok(taf.groups.length >= 3, `expected several groups, got ${taf.groups.length}`);
  assert.equal(taf.groups[0].isBase, true);
  assert.ok(taf.groups.some((g) => g.kind === 'BECMG'), 'expected a BECMG group');
  assert.ok(taf.groups.some((g) => g.probability === 30), 'expected a PROB30 group');
});

check('resolves group validity windows', () => {
  assert.ok(taf.validFrom instanceof Date && !Number.isNaN(taf.validFrom.getTime()));
  assert.ok(taf.validTo > taf.validFrom, 'validity must move forward');
  const hours = (taf.validTo - taf.validFrom) / 3600000;
  assert.equal(hours, 24, 'LEBL TAF 1118/1218 covers 24 hours');
});

check('finds the group covering departure time', () => {
  const etd = model.times.estOff;
  assert.ok(etd, 'fixture has an estimated off-block time');
  assert.ok(groupCovers(taf.groups[0], etd), 'base period should cover ETD');
});

check('rolls a TAF window into the next month', () => {
  const reference = new Date(Date.UTC(2026, 2, 31, 18, 0)); // 31 MAR
  const parsed = parseTaf('LEBL 311730Z 3118/0118 22009KT 9999 FEW020', reference);
  assert.equal(parsed.validTo.getUTCMonth(), 3, 'end date lands in April');
  assert.equal(parsed.validTo.getUTCDate(), 1);
});

console.log('\ndecode: NOTAMs');

check('ranks a closed runway above a closed taxiway', () => {
  const runway = { subject: 'Runway', status: 'Closed', text: 'RWY 24L/06R CLSD', isObstacle: false };
  const taxiway = { subject: 'Taxiway', status: 'Closed', text: 'TWY T4 CLSD', isObstacle: false };
  const obstacle = { subject: 'Obstacle', status: 'Erected', text: 'CRANE ERECTED', isObstacle: true };
  assert.equal(notamSeverity(runway, '24L'), SEVERITY.CRITICAL);
  assert.equal(notamSeverity(taxiway, '24L'), SEVERITY.WARNING);
  assert.equal(notamSeverity(obstacle, '24L'), SEVERITY.INFO);
});

check('does not treat a parallel runway closure as critical', () => {
  // LEBL has 06L/24R and 06R/24L. Closing 24R says nothing about 24L.
  const parallel = { subject: 'Runway', status: 'Closed', text: 'RWY 06L/24R CLSD', isObstacle: false };
  assert.equal(notamSeverity(parallel, '24L'), SEVERITY.WARNING);
  assert.equal(notamSeverity(parallel, '24R'), SEVERITY.CRITICAL);
  // With no planned runway known, stay conservative.
  assert.equal(notamSeverity(parallel, null), SEVERITY.CRITICAL);
});

check('a closed aerodrome is critical regardless of runway', () => {
  const field = { subject: 'Aerodrome', status: 'Closed', text: 'AD CLSD', isObstacle: false };
  assert.equal(notamSeverity(field, '24L'), SEVERITY.CRITICAL);
});

check('matches runway designators, respecting the suffix letter', () => {
  assert.equal(mentionsRunway('RWY 24L CLSD', '24L'), true);
  assert.equal(mentionsRunway('RWY 06R/24L CLSD', '24L'), true);
  assert.equal(mentionsRunway('RWY 24 CLSD', '24L'), true, 'bare designator covers the pair');
  assert.equal(mentionsRunway('RWY 24R CLSD', '24L'), false, 'a different parallel runway');
  assert.equal(mentionsRunway('RWY 06L/24R CLSD', '24L'), false);
  assert.equal(mentionsRunway('RWY 07L CLSD', '24L'), false);
  assert.equal(mentionsRunway('ELEV 240FT', '24L'), false, 'not a runway reference');
  assert.equal(mentionsRunway('FREQ 124.5', '24L'), false);
  assert.equal(mentionsRunway('RWY 04/22 CLOSED DUE TO WIP', '04'), true);
});

check('screens enroute NOTAMs by Q-code subject', () => {
  // Airspace and activity matter in the cruise; ground items do not.
  assert.equal(screenEnrouteNotam({ qcode: 'QRTCA' }).keep, true, 'temporary restricted area');
  assert.equal(screenEnrouteNotam({ qcode: 'QWMCA' }).keep, true, 'missile firing');
  assert.equal(screenEnrouteNotam({ qcode: 'QOBCE' }).keep, false, 'obstacle');
  assert.equal(screenEnrouteNotam({ qcode: 'QOLAS' }).keep, false, 'obstacle lighting');
  assert.equal(screenEnrouteNotam({ qcode: 'QMXLC' }).keep, false, 'taxiway closed');
  assert.equal(screenEnrouteNotam({ qcode: 'garbage' }).keep, false, 'unparseable code');
});

check('ranks live airspace above informational items', () => {
  assert.equal(screenEnrouteNotam({ qcode: 'QRTCA' }).severity, 2, 'activated area');
  assert.equal(screenEnrouteNotam({ qcode: 'QRDCA' }).severity, 2, 'danger area activated');
  assert.equal(screenEnrouteNotam({ qcode: 'QAFXX' }).severity, 1, 'plain-language FIR note');
});

check('cuts the enroute list to a readable size', () => {
  const routeFirs = new Set([...model.route.firs, ...model.navlog.map((f) => f.fir).filter(Boolean)]);
  const kept = model.enrouteNotams
    .filter((n) => !n.location || routeFirs.has(n.location))
    .filter((n) => screenEnrouteNotam(n).keep);

  assert.equal(model.enrouteNotams.length, 793, 'the raw list is large');
  assert.ok(kept.length > 0, 'but not everything is removed');
  assert.ok(kept.length < model.enrouteNotams.length * 0.6, `expected a real cut, kept ${kept.length}`);

  // Only airspace, warning and ATM groups survive; aerodrome and obstacle
  // items belong to the airport chapters.
  const survivingGroups = new Set(kept.map((n) => (n.qcode || '')[1]));
  assert.deepEqual([...survivingGroups].sort(), ['A', 'R', 'W']);

  // At least some of what remains is live airspace, not just plain-language notes.
  const live = kept.filter((n) => screenEnrouteNotam(n).severity === 2);
  assert.ok(live.length > 0, 'expected some activated airspace on this route');
});

check('filters notams by the flight window', () => {
  const start = new Date('2026-03-11T18:00:00Z');
  const end = new Date('2026-03-11T22:00:00Z');
  const during = { effective: '2026-03-11T17:00:00Z', expires: '2026-03-12T04:00:00Z' };
  const past = { effective: '2026-01-01T00:00:00Z', expires: '2026-01-02T00:00:00Z' };
  const future = { effective: '2026-05-01T00:00:00Z', expires: '2026-05-02T00:00:00Z' };
  assert.equal(notamActiveDuring(during, start, end), true);
  assert.equal(notamActiveDuring(past, start, end), false);
  assert.equal(notamActiveDuring(future, start, end), false);
});

console.log('\nanalyze');
const findings = analyze(model);

check('catches the 44 kg ZFW margin', () => {
  const zfw = findings.find((f) => f.label === 'ZFW');
  assert.ok(zfw, 'expected a ZFW finding');
  assert.equal(model.weights.maxZfw - model.weights.estZfw, 44);
  assert.equal(zfw.severity, SEVERITY.CRITICAL, 'a 44 kg margin is critical');
  assert.equal(zfw.chapter, 'fuel');
});

check('flags high shear points on the route', () => {
  const shearFixes = model.navlog.filter((f) => f.shear >= 4);
  const shearFindings = findings.filter((f) => /shear/i.test(f.title));
  assert.equal(shearFindings.length, shearFixes.length);
  for (const f of shearFindings) {
    assert.ok(f.ident, 'shear finding names its fix');
    assert.equal(f.chapter, 'weather');
  }
});

check('collapses widespread ISA deviation into one finding', () => {
  // A warm route trips the threshold nearly everywhere; seven near-identical
  // entries would bury the findings that actually need attention.
  const warm = normalizeOfp(JSON.parse(JSON.stringify(raw)));
  warm.navlog.forEach((f) => {
    f.isaDev = 14;
  });
  const isaFindings = analyze(warm).filter((f) => /ISA|standard/i.test(f.title));
  assert.equal(isaFindings.length, 1, 'one summary finding, not one per fix');
  assert.match(isaFindings[0].detail, /32/, 'states how many fixes exceeded');

  // An isolated pocket still gets named individually.
  const spotty = normalizeOfp(JSON.parse(JSON.stringify(raw)));
  spotty.navlog.forEach((f) => {
    f.isaDev = 0;
  });
  spotty.navlog[5].isaDev = -16;
  const spottyFindings = analyze(spotty).filter((f) => /ISA/i.test(f.title));
  assert.equal(spottyFindings.length, 1);
  assert.equal(spottyFindings[0].ident, spotty.navlog[5].ident);
});

check('records the tightest fuel margin on the model', () => {
  assert.ok(model.fuelTightest, 'expected a tightest fuel point');
  assert.ok(Number.isFinite(model.fuelTightest.margin));
  assert.equal(model.fuelTightest.margin, model.fuelTightest.fix.fuelOnBoard - model.fuelTightest.fix.fuelMinOnBoard);
});

check('computes the landing fuel margin', () => {
  const required = model.fuel.reserve + model.fuel.alternateBurn;
  assert.equal(model.landingFuelMargin, model.fuel.planLanding - required);
  assert.ok(model.landingFuelMargin > 0, 'this plan lands above reserve + alternate');
});

check('every finding is well formed', () => {
  for (const f of findings) {
    assert.ok([1, 2, 3].includes(f.severity), `bad severity: ${f.severity}`);
    assert.ok(
      ['weather', 'notams', 'fuel', 'performance', 'navlog'].includes(f.chapter),
      `bad chapter: ${f.chapter}`
    );
    assert.ok(typeof f.title === 'string' && f.title.length, 'finding needs a title');
    assert.ok(typeof f.detail === 'string', 'finding needs a detail string');
    assert.ok(f.id, 'finding needs an id');
  }
});

check('sorts findings most severe first', () => {
  for (let i = 1; i < findings.length; i += 1) {
    assert.ok(findings[i - 1].severity >= findings[i].severity, 'severity must not increase');
  }
});

check('counts findings per chapter for the nav badges', () => {
  const counts = countByChapter(findings);
  const total = Object.values(counts).reduce((sum, c) => sum + c.total, 0);
  assert.equal(total, findings.length);
});

console.log('\nresilience');

check('survives an OFP with missing optional sections', () => {
  const stripped = JSON.parse(JSON.stringify(raw));
  delete stripped.tlr;
  delete stripped.impacts;
  delete stripped.images;
  stripped.sigmets = '';
  stripped.origin.atis = '';
  stripped.origin.notam = '';
  stripped.alternate = '';

  const lean = normalizeOfp(stripped);
  assert.equal(lean.tlr.takeoff, null);
  assert.deepEqual(lean.origin.atis, []);
  assert.deepEqual(lean.origin.notams, []);
  assert.deepEqual(lean.alternates, []);
  assert.deepEqual(lean.images.all, []);

  const leanFindings = analyze(lean);
  assert.ok(Array.isArray(leanFindings), 'analyse still returns findings');
});

check('treats the live API empty-object as blank, not as text', () => {
  // The XML export writes empty elements as ""; the live JSON API returns {}.
  // Stringifying the latter used to render "[object Object]" across the UI.
  assert.equal(str({}), null);
  assert.equal(str(''), null);
  assert.equal(num({}), null);
  assert.equal(flag({}), false, 'an empty object is not a set flag');
  assert.equal(flag('1'), true);
  assert.equal(flag('0'), false);
  assert.deepEqual(arr({}), [], 'an empty object is not a one-item list');
  assert.deepEqual(arr([{}, { a: 1 }]), [{ a: 1 }], 'blank entries are dropped');
  // Real values still survive.
  assert.equal(str('DIPE2F'), 'DIPE2F');
  assert.equal(num('320'), 320);
});

check('normalizes an OFP shaped like the live API response', () => {
  const live = JSON.parse(JSON.stringify(raw));
  // Reproduce how the live endpoint reports absent fields.
  live.general.sid_ident = {};
  live.general.star_ident = {};
  live.origin.notam[0].notam_schedule = {};
  live.origin.notam[0].date_expire_is_estimated = {};
  live.origin.notam[0].notam_is_obstacle = {};
  live.origin.atis = live.origin.atis[0]; // single item comes back as an object
  live.alternate = live.alternate[0];

  const m = normalizeOfp(live);
  assert.equal(m.route.sid, null, 'absent SID is null, not "[object Object]"');
  assert.equal(m.route.star, null);
  assert.equal(m.origin.notams[0].schedule, null);
  assert.equal(m.origin.notams[0].expiryEstimated, false, 'blank flag must not read as true');
  assert.equal(m.origin.notams[0].isObstacle, false);
  assert.equal(m.origin.atis.length, 1, 'a single ATIS object becomes a one-item list');
  assert.equal(m.alternates.length, 1, 'a single alternate object becomes a one-item list');
  assert.equal(m.alternates[0].icao, 'LCPH');

  // Nothing anywhere in the model should stringify to [object Object].
  const serialized = JSON.stringify(m.route) + JSON.stringify(m.flight) + JSON.stringify(m.origin.notams);
  assert.equal(serialized.includes('[object'), false);
});

check('drops a phantom alternate when the OFP has none', () => {
  const noAltn = JSON.parse(JSON.stringify(raw));
  noAltn.alternate = {};
  const m = normalizeOfp(noAltn);
  assert.deepEqual(m.alternates, [], 'an empty alternate node must not become a card');
});

check('handles a runway with no V speeds', () => {
  const rwy = model.tlr.takeoff.runways[0];
  assert.equal(rwy.v1, null, 'this aircraft profile provides no V1');
  assert.equal(rwy.vref, 154, 'but it does provide VREF40');
});

check('rejects an unrecognised payload', () => {
  assert.throws(() => normalizeOfp({}), /Unrecognised OFP/);
});

/* --------------------------------------------- live weather against the plan */

check('derives the flight category from a raw observation', () => {
  assert.equal(flightCategory(parseMetar('LEBL 101630Z 09007KT CAVOK 30/28 Q1015')), 'vfr');
  // 400ft overcast is LIFR on ceiling alone, whatever the visibility says.
  assert.equal(flightCategory(parseMetar('LEBL 101630Z 09007KT 9999 OVC004 10/09 Q1015')), 'lifr');
  // 2,000m visibility is IFR even under a clear sky.
  assert.equal(flightCategory(parseMetar('LEBL 101630Z 09007KT 2000 10/09 Q1015')), 'ifr');
  // The worse of the two drives it: MVFR ceiling, IFR visibility -> IFR.
  assert.equal(flightCategory(parseMetar('LEBL 101630Z 09007KT 3000 BKN020 10/09 Q1015')), 'ifr');
  assert.equal(categoryRank('lifr') > categoryRank('vfr'), true);
});

check('resolves the live wind onto the planned runway', () => {
  const runway = model.tlr.takeoff.runways.find((r) => r.identifier === '24L');
  assert.ok(runway, 'the fixture plans 24L');

  // Straight down 24L, whose true course is 246: all headwind, no crosswind.
  assert.equal(runway.trueCourse, 246);
  const down = runwayWind(runway, parseMetar('LEBL 101630Z 24615KT 9999 20/10 Q1015'));
  assert.equal(down.headwind, 15);
  assert.equal(down.crosswind, 0);

  // From behind: a tailwind is a negative headwind, and worstTailwind names it.
  const behind = runwayWind(runway, parseMetar('LEBL 101630Z 05910KT 9999 20/10 Q1015'));
  assert.equal(behind.headwind, -10);
  assert.equal(behind.worstTailwind, 10);
});

check('assesses gusts and a variable arc as the worst case', () => {
  const runway = model.tlr.takeoff.runways.find((r) => r.identifier === '24L');

  // Crosswind is judged on the gust, not the mean.
  const gusty = runwayWind(runway, parseMetar('LEBL 101630Z 14915G30KT 9999 20/10 Q1015'));
  assert.equal(gusty.crosswind, 15, 'steady crosswind from the mean');
  assert.equal(gusty.worstCrosswind, 30, 'but the gust is what has to be flown');

  // A wind free to sit anywhere in 060V150 must be judged at its worst point.
  const variable = runwayWind(runway, parseMetar('LEBL 101630Z 09020KT 060V150 9999 20/10 Q1015'));
  assert.equal(variable.worstCrosswind >= variable.crosswind, true);
  assert.equal(variable.arc.from, 60);
  assert.equal(variable.arc.to, 150);
});

check('says nothing about a wind with no direction', () => {
  const runway = model.tlr.takeoff.runways.find((r) => r.identifier === '24L');
  assert.equal(runwayWind(runway, parseMetar('LEBL 101630Z 00000KT 9999 20/10 Q1015')).calm, true);
  assert.equal(
    runwayWind(runway, parseMetar('LEBL 101630Z VRB04KT 9999 20/10 Q1015')).variable,
    true
  );
});

/* -------------------------------------------------------------- timeline */

/** localStorage stand-in, so the stores under test have somewhere to write. */
function withStorage(run) {
  const data = {};
  globalThis.localStorage = {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    }
  };
  try {
    run();
  } finally {
    delete globalThis.localStorage;
  }
}

check('tracks the two spans that anchor the clock, and nothing else', () => {
  assert.deepEqual(PHASES.map((p) => p.key), ['takeoff', 'landing']);

  withStorage(() => {
    assert.equal(phaseState(getTimeline(model), 'takeoff'), 'pending');

    startPhase(model, 'takeoff', 1000);
    assert.equal(phaseState(getTimeline(model), 'takeoff'), 'running');

    // Wheels up opens the flight span, so it does not need starting by hand.
    const after = completePhase(model, 'takeoff', 2000);
    assert.equal(phaseState(after, 'takeoff'), 'done');
    assert.equal(phaseState(after, 'landing'), 'running');
    assert.equal(after.current, 'landing');

    // And a mis-tap can be taken back, along with the span it opened.
    const reopened = reopenPhase(model, 'takeoff');
    assert.equal(phaseState(reopened, 'takeoff'), 'running');
    assert.equal(phaseState(reopened, 'landing'), 'pending');
  });
});

check('rebases the whole clock off the real wheels-up', () => {
  withStorage(() => {
    const before = rebasedTimes(model, getTimeline(model));
    assert.equal(before.started, false, 'nothing is rebased until takeoff is marked');

    // Airborne at exactly 19:00Z on the plan's own day.
    const off = Date.UTC(2026, 2, 11, 19, 0, 0);
    completePhase(model, 'takeoff', off);
    const clock = rebasedTimes(model, getTimeline(model));

    assert.equal(clock.started, true);
    assert.equal(clock.actual.off.getTime(), off);

    // Landing is takeoff plus the plan's enroute time; on-blocks adds taxi in.
    assert.equal(
      clock.actual.on.getTime(),
      off + model.times.estTimeEnroute * 1000,
      'landing follows from the plan, not from the schedule it missed'
    );
    assert.equal(clock.actual.in.getTime(), clock.actual.on.getTime() + model.times.taxiIn * 1000);

    // The plan said 18:30Z, so this is half an hour late.
    assert.equal(clock.delaySeconds, 1800);
    assert.equal(clock.planned.off.getTime(), model.times.estOff.getTime(), 'the plan is kept');

    // Every fix moves with it.
    const fix = model.navlog.find((f) => f.timeTotal > 0);
    assert.equal(fixEta(model, getTimeline(model), fix).getTime(), off + fix.timeTotal * 1000);

    // An hour in, the aircraft is between the fixes either side of that hour.
    const leg = currentLeg(model, getTimeline(model), off + 3600 * 1000);
    assert.equal(leg.passed.timeTotal <= 3600, true);
    assert.equal(leg.next.timeTotal > 3600, true);
  });
});

check('asks for fuel at the points that carry information', () => {
  const points = fuelCheckpoints(model);
  const whys = points.map((p) => p.why);

  assert.equal(whys[0], 'toc', 'the climb burn is only known at the top of it');
  assert.equal(whys.at(-1), 'destination');
  assert.equal(whys.includes('tod'), true);
  assert.equal(points.length < 8, true, `${points.length} prompts is too many to read`);

  // Strictly ordered, and never the same fix twice.
  const times = points.map((p) => p.fix.timeTotal);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(new Set(points.map((p) => p.fix.index)).size, points.length);

  // No cruise check crowding the top of descent.
  const tod = points.find((p) => p.why === 'tod');
  const crowding = points.filter(
    (p) => p.why === 'cruise' && tod.fix.timeTotal - p.fix.timeTotal < 20 * 60
  );
  assert.deepEqual(crowding, []);
});

check('only asks about a checkpoint the flight has actually reached', () => {
  withStorage(() => {
    const points = fuelCheckpoints(model);
    const first = points[0];

    assert.equal(dueCheckpoint(model, getTimeline(model), {}), null, 'nothing due before takeoff');

    const off = Date.UTC(2026, 2, 11, 19, 0, 0);
    completePhase(model, 'takeoff', off);
    const timeline = getTimeline(model);

    // A minute before the first checkpoint, nothing is owed yet.
    assert.equal(dueCheckpoint(model, timeline, {}, off + (first.fix.timeTotal - 60) * 1000), null);

    // A minute after, it is.
    const due = dueCheckpoint(model, timeline, {}, off + (first.fix.timeTotal + 60) * 1000);
    assert.equal(due.fix.index, first.fix.index);

    // Answered, it stops being asked -- and the next one is not yet due.
    const answered = dueCheckpoint(
      model,
      timeline,
      { [first.fix.index]: 11400 },
      off + (first.fix.timeTotal + 60) * 1000
    );
    assert.equal(answered, null);
  });
});

/* -------------------------------------------------------- NOTAM read state */

check('keys a NOTAM by its number, falling back to its text', () => {
  assert.equal(notamKey({ id: ' a1234/25 ' }), 'A1234/25');

  // Two untitled NOTAMs must not collapse onto one key.
  const one = notamKey({ text: 'RWY 06L/24R CLOSED' });
  const two = notamKey({ text: 'TWY B CLOSED' });
  assert.notEqual(one, two);
  assert.equal(notamKey({ text: 'RWY 06L/24R CLOSED' }), one, 'and the key is stable');

  assert.equal(notamKey({}), null, 'nothing to key on');
});

check('remembers which NOTAMs have been read', () => {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
      store[k] = v;
    }
  };

  const notams = model.origin.notams;
  assert.equal(unreadCount(notams), notams.length, 'everything is unread to begin with');

  markRead(notams);
  assert.equal(unreadCount(notams), 0);
  assert.equal(isRead(notams[0]), true);

  // A NOTAM that was not in the batch stays unread -- this is what makes the
  // second pass through a briefing worth doing.
  const arrival = model.destination.notams[0];
  assert.equal(isRead(arrival), false);

  markUnread(notams);
  assert.equal(unreadCount(notams), notams.length);

  delete globalThis.localStorage;
});

check('raises a finding when the live weather has moved off the plan', () => {
  const live = {
    state: 'ready',
    metars: {
      // Planned 239/14 down 24L; this puts it behind and across, in fog.
      [model.origin.icao]: 'LEBL 101630Z 05925G40KT 0500 OVC002 10/09 Q1015'
    }
  };

  const withLive = analyze(model, live);
  const titles = withLive.map((f) => f.title).join(' | ');

  assert.match(titles, /now downwind/, 'a planned headwind that became a tailwind');
  assert.match(titles, /deteriorated since planning/, 'VFR plan, LIFR observation');

  // And none of it appears without the live feed.
  const planOnly = analyze(model).map((f) => f.title).join(' | ');
  assert.equal(/now downwind|deteriorated since planning/.test(planOnly), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
