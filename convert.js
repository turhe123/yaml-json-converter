// convert.js — pure YAML <-> JSON conversion, shared by app.js (main thread) and worker.js (large inputs).
// Uses the vendored js-yaml (UMD build sets globalThis.jsyaml when imported as a module).
import './vendor/js-yaml/js-yaml.min.js';

const Y = globalThis.jsyaml;

// Per-conversion collectors, filled by the custom types below while js-yaml constructs values.
let collect = null;

const baseInt = Y.types.int;
const baseTs = Y.types.timestamp;
const baseBool = Y.types.bool;

// Integers: keep leading-zero values ("007", "0644") and integers beyond 2^53 as strings so nothing is lost.
const intType = new Y.Type('tag:yaml.org,2002:int', {
  ...baseInt.options,
  construct(data) {
    const clean = data.replace(/_/g, '');
    if (/^[-+]?0[0-9]+$/.test(clean)) { collect && collect.leadingZero.add(data); return data; }
    const n = baseInt.construct(data);
    if (!Number.isSafeInteger(n)) { collect && collect.bigInt.add(data); return clean; }
    return n;
  },
});

// Timestamps become ISO strings: a bare date stays "2024-05-01", date-times become full ISO 8601 in UTC.
const tsType = new Y.Type('tag:yaml.org,2002:timestamp', {
  ...baseTs.options,
  construct(data) {
    if (/^\d{4}-\d\d-\d\d$/.test(data)) return data;
    return baseTs.construct(data).toISOString();
  },
});

// YAML 1.1 booleans (yes/no/on/off/y/n), only when the user picks that schema.
const BOOL11_TRUE = /^(?:y|Y|yes|Yes|YES|on|On|ON|true|True|TRUE)$/;
const BOOL11_FALSE = /^(?:n|N|no|No|NO|off|Off|OFF|false|False|FALSE)$/;
const bool11Type = new Y.Type('tag:yaml.org,2002:bool', {
  ...baseBool.options,
  resolve: (d) => d !== null && (BOOL11_TRUE.test(d) || BOOL11_FALSE.test(d)),
  construct: (d) => BOOL11_TRUE.test(d),
});

// Lenient mode: any local tag (!Ref, !Sub, !include…) is kept as { "!Tag": value } instead of refused.
const anyTag = (kind) => new Y.Type('!', {
  kind,
  multi: true,
  representName: (obj) => Object.keys(obj)[0],
  construct: (data, tag) => ({ [tag]: data === null ? (kind === 'mapping' ? {} : kind === 'sequence' ? [] : '') : data }),
});

const SCHEMAS = {
  'core-safe': Y.DEFAULT_SCHEMA.extend({ implicit: [intType, tsType] }),
  'core-tags': Y.DEFAULT_SCHEMA.extend({ implicit: [intType, tsType], explicit: [anyTag('scalar'), anyTag('sequence'), anyTag('mapping')] }),
  'yaml11-safe': Y.DEFAULT_SCHEMA.extend({ implicit: [bool11Type, intType, tsType] }),
  'yaml11-tags': Y.DEFAULT_SCHEMA.extend({ implicit: [bool11Type, intType, tsType], explicit: [anyTag('scalar'), anyTag('sequence'), anyTag('mapping')] }),
};

export const DEFAULTS = { direction: 'y2j', indent: 2, sortKeys: false, schema: 'core', safe: true, flow: false, fold: false };

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = Object.create(null);
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- error helpers ----------

export function lineColFromPos(text, pos) {
  pos = Math.max(0, Math.min(pos, text.length));
  let line = 1, last = -1;
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) { line++; last = i; }
  return { line, column: pos - last };
}

// A few lines of context with line numbers and a caret under the column (1-based line/column).
export function makeSnippet(text, line, column) {
  const lines = text.split(/\r?\n/);
  const from = Math.max(1, line - 2), to = Math.min(lines.length, line + 1);
  const width = String(to).length;
  const out = [];
  for (let n = from; n <= to; n++) {
    const raw = (lines[n - 1] ?? '').replace(/\t/g, '→');
    out.push(`${n === line ? '>' : ' '} ${String(n).padStart(width)} | ${raw.length > 160 ? raw.slice(0, 160) + '…' : raw}`);
    if (n === line) out.push(`  ${' '.repeat(width)} | ${' '.repeat(Math.max(0, column - 1))}^`);
  }
  return out.join('\n');
}

function yamlAdvice(text, reason, line) {
  const lines = text.split(/\r?\n/);
  const near = lines.slice(Math.max(0, line - 3), line + 1);
  const tips = [];
  if (/tab/i.test(reason) || near.some((l) => /^ *\t/.test(l))) tips.push('YAML does not allow tab characters for indentation. Replace the tabs at the start of the line with spaces (2 per level is usual).');
  if (/duplicated mapping key/.test(reason)) tips.push('The same key appears twice in one mapping. Rename or remove one of them; YAML requires keys to be unique.');
  const noSpace = near.find((l) => /^\s*(?:- )?[A-Za-z0-9_.\-"']+:[^\s:/\\]/.test(l) && !/^\s*#/.test(l));
  if (noSpace) tips.push(`A colon needs a space after it to start a value: write "${noSpace.trim().replace(/:(?=\S)/, ': ')}" instead of "${noSpace.trim()}".`);
  if (/unknown tag/.test(reason)) tips.push('Safe mode refuses custom tags such as !Ref or !!python/object. If you trust this file, turn off safe mode in Options to keep tags as { "!Tag": value }.');
  if (/bad indentation|end of the stream or a document separator|block mapping entry/.test(reason) && !tips.length) tips.push('Check the indentation: entries at the same level must start in the same column, and a value cannot sit on the same line as a nested key.');
  if (/unidentified alias/.test(reason)) tips.push('An alias (*name) points to an anchor (&name) that is not defined earlier in the document.');
  if (/[“”‘’]/.test(near.join('\n'))) tips.push('Curly “smart” quotes are not YAML quotes. Replace them with straight " or \' quotes.');
  return tips;
}

function jsonAdvice(text, pos) {
  const tips = [];
  const ch = text[pos];
  const before = text.slice(0, pos).trimEnd();
  if ((ch === '}' || ch === ']') && before.endsWith(',')) tips.push('JSON does not allow a trailing comma before a closing bracket. Remove the last comma.');
  if (ch === "'") tips.push("JSON strings and keys need double quotes (\"), not single quotes (').");
  if (ch === '/' || ch === '#') tips.push('JSON does not allow comments. Remove them (YAML allows # comments if you need them).');
  if (/[A-Za-z_$]/.test(ch || '') && /[{,]\s*$/.test(before)) tips.push('Object keys must be wrapped in double quotes, for example {"name": 1}.');
  if (/[“”‘’]/.test(text)) tips.push('The text contains curly “smart” quotes (often inserted by phone keyboards). Replace them with straight " quotes.');
  if (pos >= text.length) tips.push('The text ended early. Check for a missing closing } or ] or an unfinished string.');
  return tips;
}

function yamlError(text, e) {
  const line = (e.mark?.line ?? 0) + 1;
  const column = (e.mark?.column ?? 0) + 1;
  const reason = e.reason || e.message;
  return { lang: 'YAML', message: reason, line, column, position: e.mark?.position ?? 0, snippet: makeSnippet(text, line, column), advice: yamlAdvice(text, reason, line) };
}

// Finds where JSON breaks when the browser's message has no position (for example "Unexpected token ']'").
function locateJsonError(t) {
  let i = 0;
  const ws = () => { while (i < t.length && ' \t\n\r'.includes(t[i])) i++; };
  const fail = () => { throw i; };
  const str = () => {
    i++;
    while (i < t.length && t[i] !== '"') { if (t[i] === '\\') i++; else if (t[i] < ' ') fail(); i++; }
    if (i >= t.length) fail();
    i++;
  };
  const val = () => {
    ws();
    const c = t[i];
    if (c === '{') {
      i++; ws();
      if (t[i] === '}') { i++; return; }
      for (;;) { ws(); if (t[i] !== '"') fail(); str(); ws(); if (t[i] !== ':') fail(); i++; val(); ws(); if (t[i] === ',') { i++; continue; } if (t[i] === '}') { i++; return; } fail(); }
    }
    if (c === '[') {
      i++; ws();
      if (t[i] === ']') { i++; return; }
      for (;;) { val(); ws(); if (t[i] === ',') { i++; continue; } if (t[i] === ']') { i++; return; } fail(); }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i, i + 400));
    if (!m) fail();
    i += m[0].length;
  };
  try { val(); ws(); if (i < t.length) fail(); } catch (pos) { if (typeof pos === 'number') return pos; throw pos; }
  return 0;
}

function jsonError(text, e) {
  const msg = String(e.message || e);
  let pos, line, column;
  const lc = msg.match(/line (\d+) column (\d+)/);
  const p = msg.match(/position (\d+)/);
  if (p) pos = +p[1];
  if (lc) { line = +lc[1]; column = +lc[2]; }
  if (pos === undefined && line) {
    const ls = text.split('\n');
    pos = ls.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0) + column - 1;
  }
  if (pos === undefined) pos = locateJsonError(text);
  if (!line) ({ line, column } = lineColFromPos(text, pos));
  const message = msg.replace(/^JSON\.parse: /, '').replace(/ in JSON at position \d+.*$/, '').replace(/ at line \d+ column \d+ of the JSON data$/, '').replace(/^(Unexpected token .+?), (?:"|\.\.\.).*is not valid JSON$/s, '$1');
  return { lang: 'JSON', message, line, column, position: pos, snippet: makeSnippet(text, line, column), advice: jsonAdvice(text, pos) };
}

// Aliases (*name) that point to anchors (&name) defined in the text: these get expanded into copies.
function countAliases(text) {
  const anchors = new Set();
  for (const m of text.matchAll(/(?:^|[\s\[{,])&([^\s,\[\]{}]+)/gm)) anchors.add(m[1]);
  if (!anchors.size) return { aliases: 0, merges: 0 };
  let aliases = 0;
  for (const m of text.matchAll(/(?:^|[\s\[{,])\*([^\s,\[\]{}]+)/gm)) if (anchors.has(m[1])) aliases++;
  const merges = (text.match(/^\s*(?:- )?<<\s*:/gm) || []).length;
  return { aliases, merges };
}

// Integers in JSON text that do not fit a double are quoted before parsing so their digits survive.
function protectBigJsonInts(text, warn) {
  const re = /"(?:[^"\\\n]|\\.)*"|-?\d{16,}(?![.\deE])/g;
  let changed = false;
  const out = text.replace(re, (tok) => {
    if (tok[0] === '"') return tok;
    if (Number.isSafeInteger(Number(tok))) return tok;
    warn.add(tok); changed = true;
    return `"${tok}"`;
  });
  return changed ? out : text;
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const list = (set, max = 3) => [...set].slice(0, max).join(', ') + (set.size > max ? ', …' : '');

// ---------- main entry ----------

export function convert(rawText, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const text = String(rawText ?? '').replace(/^\uFEFF/, '');
  const bom = text.length !== String(rawText ?? '').length;
  const notes = [], warnings = [];
  if (bom) notes.push('A byte order mark (BOM) at the start was removed.');
  if (!text.trim()) return { ok: true, empty: true, output: '', notes, warnings, docs: 0 };

  if (o.direction === 'y2j') {
    collect = { leadingZero: new Set(), bigInt: new Set() };
    let docs;
    try {
      docs = Y.loadAll(text, null, { schema: SCHEMAS[`${o.schema === 'yaml11' ? 'yaml11' : 'core'}-${o.safe ? 'safe' : 'tags'}`] });
    } catch (e) {
      collect = null;
      if (e && e.name === 'YAMLException') return { ok: false, error: yamlError(text, e), notes, warnings };
      throw e;
    }
    const { leadingZero, bigInt } = collect;
    collect = null;
    while (docs.length > 1 && docs[docs.length - 1] == null) docs.pop(); // a trailing "---" is not a document
    const value = docs.length === 1 ? docs[0] : docs;
    if (docs.length > 1) notes.push(`${docs.length} YAML documents (separated by ---) were combined into one JSON array.`);
    if (docs.length === 0) notes.push('The YAML contains no document, so the JSON is null.');
    const { aliases, merges } = countAliases(text);
    if (aliases) notes.push(`Anchors and aliases were expanded: ${plural(aliases, 'alias', 'aliases')}${merges ? ` (including ${plural(merges, 'merge key')})` : ''} replaced by copies of the anchored data, since JSON has no references.`);
    if (leadingZero.size) notes.push(`Values with leading zeros were kept as strings so no digits are lost: ${list(leadingZero)}.`);
    if (bigInt.size) warnings.push(`Integers beyond the safe range of JSON numbers (±2^53) were kept as strings to preserve every digit: ${list(bigInt)}.`);
    if (o.schema !== 'yaml11' && /(?:^|[:\-\[,{]\s)\s*(?:yes|no|on|off|y|n|Yes|No|On|Off|YES|NO|ON|OFF)\s*(?:#.*)?$/m.test(text)) {
      notes.push('Values like yes, no, on and off are plain strings in YAML 1.2 (used here). Tools that follow YAML 1.1 read them as true or false; pick "YAML 1.1" under Schema to match them.');
    }
    let nonFinite = 0;
    const replacer = (k, v) => {
      if (typeof v === 'number' && !Number.isFinite(v)) { nonFinite++; return Number.isNaN(v) ? '.nan' : v > 0 ? '.inf' : '-.inf'; }
      if (v instanceof Uint8Array) return bytesToBase64(v);
      return v;
    };
    let output;
    try {
      output = JSON.stringify(o.sortKeys ? sortDeep(value) : value, replacer, o.indent);
    } catch (e) {
      const recursive = /circular/i.test(String(e.message));
      return { ok: false, notes, warnings, error: { lang: 'YAML', message: recursive ? 'This YAML refers to itself through an alias (a recursive anchor), which cannot be written as JSON.' : String(e.message), line: 1, column: 1, position: 0, snippet: '', advice: [] } };
    }
    if (nonFinite) warnings.push(`JSON has no infinity or NaN, so ${plural(nonFinite, 'value')} such as .inf or .nan became strings.`);
    return { ok: true, output: output === undefined ? 'null' : output + '\n', notes, warnings, docs: docs.length };
  }

  // JSON -> YAML
  const bigInt = new Set();
  let value;
  const safeText = protectBigJsonInts(text, bigInt);
  try {
    value = JSON.parse(safeText);
  } catch (e) {
    // report positions against the user's text, not the protected copy
    try { JSON.parse(text); } catch (e2) { return { ok: false, error: jsonError(text, e2), notes, warnings }; }
    return { ok: false, error: jsonError(text, e), notes, warnings };
  }
  if (bigInt.size) warnings.push(`Integers beyond the safe range of JavaScript numbers (±2^53) were kept as quoted strings to preserve every digit: ${list(bigInt)}.`);
  const output = Y.dump(value, {
    indent: o.indent,
    sortKeys: o.sortKeys,
    flowLevel: o.flow ? 0 : -1,
    lineWidth: o.fold ? 80 : -1,
    noRefs: true,
    schema: Y.DEFAULT_SCHEMA,
  });
  return { ok: true, output, notes, warnings, docs: 1 };
}
