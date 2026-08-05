/**
 * Converts a SimBrief OFP XML file into the same JSON shape the SimBrief API
 * returns for `&json=1`, so the offline fixture and live data are interchangeable.
 *
 *   node tools/xml2json.js <input.xml> <output.json>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Tags that must always be arrays. XML gives us no way to tell "a list that
 * happens to hold one item" from "a single object", but SimBrief's JSON always
 * uses an array for these, so we pin them.
 */
const FORCE_ARRAY = new Set([
  'fix',
  'notam',
  'notamdrec',
  'atis',
  'runway',
  'map',
  'file',
  'fir_enroute',
  'alternate',
  'sigmet',
  'track',
  'enroute_altn',
  'takeoff_altn'
]);

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return entity in ENTITIES ? ENTITIES[entity] : match;
  });
}

/**
 * Minimal XML reader. SimBrief output is machine generated and well formed, so
 * this only needs to cover declarations, comments, CDATA, self-closing tags and
 * plain attributes.
 */
function parseXml(xml) {
  const root = { children: [], name: '#root', text: '' };
  const stack = [root];
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);

    if (lt === -1) {
      appendText(stack[stack.length - 1], xml.slice(i));
      break;
    }

    if (lt > i) appendText(stack[stack.length - 1], xml.slice(i, lt));

    // Declarations, doctypes and comments carry nothing we need.
    if (xml.startsWith('<?', lt)) {
      i = xml.indexOf('?>', lt) + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      i = xml.indexOf('-->', lt) + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      stack[stack.length - 1].text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      i = xml.indexOf('>', lt) + 1;
      continue;
    }

    const gt = xml.indexOf('>', lt);
    if (gt === -1) break;
    const raw = xml.slice(lt + 1, gt).trim();

    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const inner = selfClosing ? raw.slice(0, -1).trim() : raw;
    const spaceAt = inner.search(/\s/);
    const name = spaceAt === -1 ? inner : inner.slice(0, spaceAt);

    const node = { name, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);

    i = gt + 1;
  }

  return root;
}

function appendText(node, chunk) {
  node.text += decodeEntities(chunk);
}

/** Collapses a parsed node into the SimBrief JSON representation. */
function toValue(node) {
  if (node.children.length === 0) {
    return node.text.trim();
  }

  const out = {};
  const counts = new Map();
  for (const child of node.children) {
    counts.set(child.name, (counts.get(child.name) || 0) + 1);
  }

  for (const child of node.children) {
    const value = toValue(child);
    const isList = counts.get(child.name) > 1 || FORCE_ARRAY.has(child.name);

    if (isList) {
      if (!Array.isArray(out[child.name])) out[child.name] = [];
      out[child.name].push(value);
    } else {
      out[child.name] = value;
    }
  }

  return out;
}

/**
 * Strips SimBrief account identifiers. The fixture ships in a public repo as
 * demo data; the flight itself is what matters, the account behind it is not.
 */
function anonymize(ofp) {
  if (ofp.params) {
    ofp.params.user_id = '000000';
    ofp.params.request_id = '000000000';
    ofp.params.sequence_id = '000000000000';
    ofp.params.xml_file = '';
  }
  if (ofp.aircraft) {
    ofp.aircraft.internal_id = '';
  }
  if (ofp.crew) {
    for (const key of Object.keys(ofp.crew)) {
      if (typeof ofp.crew[key] === 'string') ofp.crew[key] = '';
    }
  }
  delete ofp.prefile;
  delete ofp.vatsim_prefile;
  delete ofp.ivao_prefile;
  delete ofp.pilotedge_prefile;
  delete ofp.poscon_prefile;
  delete ofp.api_params;
  delete ofp.offset_data;
  return ofp;
}

const args = process.argv.slice(2);
const keepIdentity = args.includes('--keep-identity');
const [inputPath, outputPath] = args.filter((a) => !a.startsWith('--'));

if (!inputPath || !outputPath) {
  console.error('Usage: node tools/xml2json.js <input.xml> <output.json> [--keep-identity]');
  process.exit(1);
}

const xml = readFileSync(inputPath, 'utf8');
const tree = parseXml(xml);
const ofpNode = tree.children.find((child) => child.name === 'OFP');

if (!ofpNode) {
  console.error('No <OFP> element found in the input file.');
  process.exit(1);
}

const ofp = keepIdentity ? toValue(ofpNode) : anonymize(toValue(ofpNode));

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(ofp, null, 1), 'utf8');

console.log(`Wrote ${outputPath}`);
console.log(`  flight        ${ofp.general?.icao_airline || ''}${ofp.general?.flight_number || ''}`);
console.log(`  route         ${ofp.origin?.icao_code} -> ${ofp.destination?.icao_code}`);
console.log(`  navlog fixes  ${ofp.navlog?.fix?.length ?? 0}`);
console.log(`  notams        ${ofp.notams?.notamdrec?.length ?? 0} enroute / ${ofp.origin?.notam?.length ?? 0} origin`);
console.log(`  images        ${ofp.images?.map?.length ?? 0}`);
