// app.js — YAML <-> JSON converter UI (ES module). Everything runs on this device; nothing is stored or sent.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';
import { convert } from './convert.js';

const $ = (id) => document.getElementById(id);
const input = $('input');
const output = $('output');
const results = $('results');
const badge = $('badge');
const progress = $('progress');
const downloadBtn = $('download');
const copyBtn = $('copy');
const opt = { indent: $('opt-indent'), schema: $('opt-schema'), style: $('opt-style'), sort: $('opt-sort'), fold: $('opt-fold'), safe: $('opt-safe') };

const WORKER_THRESHOLD = 2 * 1024 * 1024; // characters; bigger inputs are converted in worker.js
const DEBOUNCE_MS = 200;
const ACCEPTED = /\.(ya?ml|json)$/i;

const SAMPLE_YAML = `# A fictional Docker Compose file for a made-up blog
name: inkwell-blog
services:
  web:
    image: inkwell/web:2.4.1
    ports:
      - "8080:80"
    environment: &common_env
      TZ: UTC
      LOG_LEVEL: info
    depends_on:
      - db
  db:
    image: postgres:16-alpine
    environment:
      <<: *common_env
      POSTGRES_DB: inkwell
      POSTGRES_PASSWORD: change-me-example
    volumes:
      - blog-data:/var/lib/postgresql/data
volumes:
  blog-data: {}
`;

let direction = 'y2j';
let fileBase = null;       // name of the opened file without extension, reused for downloads
let lastResult = null;
let extraAlerts = [];      // messages about rejected files, shown until the next edit
let jobId = 0;
let timer = 0;
let worker = null;

const inLang = () => (direction === 'y2j' ? 'YAML' : 'JSON');
const outLang = () => (direction === 'y2j' ? 'JSON' : 'YAML');
const outExt = () => (direction === 'y2j' ? 'json' : 'yaml');
const outName = () => `${fileBase || 'converted'}.${outExt()}`;

function options() {
  return {
    direction,
    indent: Number(opt.indent.value) === 4 ? 4 : 2,
    schema: opt.schema.value,
    flow: opt.style.value === 'flow',
    sortKeys: opt.sort.checked,
    fold: opt.fold.checked,
    safe: opt.safe.checked,
  };
}

function updateLabels() {
  $('input-label').textContent = `${inLang()} input`;
  $('output-label').textContent = `${outLang()} output`;
  input.placeholder = `Paste ${inLang()} here, or drop a .yaml, .yml or .json file`;
  downloadBtn.textContent = `Download ${outName()}`;
  $(direction === 'y2j' ? 'dir-y2j' : 'dir-j2y').checked = true;
}

function setBadge(state, text) {
  badge.dataset.state = state;
  badge.textContent = text;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function errorAlert(err) {
  const box = el('div', 'alert alert--error yj-error');
  box.setAttribute('role', 'alert');
  const head = el('p', 'yj-error__title');
  head.append(el('strong', null, `Invalid ${err.lang}: `), document.createTextNode(err.message));
  box.append(head);
  if (err.snippet) {
    box.append(el('p', 'yj-error__where', `Line ${err.line}, column ${err.column}`));
    box.append(el('pre', 'code yj-snippet', err.snippet));
  }
  if (err.advice?.length) {
    const ul = el('ul', 'yj-advice');
    err.advice.forEach((a) => ul.append(el('li', null, a)));
    box.append(ul);
  }
  if (err.snippet) {
    const go = el('button', 'btn btn--small', `Go to line ${err.line}`);
    go.type = 'button';
    go.addEventListener('click', () => goTo(err.position, err.line));
    box.append(go);
  }
  return box;
}

function goTo(position, line) {
  input.focus();
  const end = Math.min(position + 1, input.value.length);
  input.setSelectionRange(position, end);
  const lh = parseFloat(getComputedStyle(input).lineHeight) || 20;
  input.scrollTop = Math.max(0, (line - 3) * lh);
}

function render(res, { reveal = false } = {}) {
  lastResult = res;
  const nodes = [];
  extraAlerts.forEach((m) => {
    const a = el('div', 'alert alert--error', m);
    a.setAttribute('role', 'alert');
    nodes.push(a);
  });

  if (res.empty) {
    output.value = '';
    output.placeholder = 'The converted result appears here as you type.';
    setBadge('empty', 'Empty');
    nodes.push(el('div', 'alert yj-calm', `Paste ${inLang()} on the left, or drop a .yaml, .yml or .json file, and the ${outLang()} appears on the right.`));
  } else if (!res.ok) {
    output.value = '';
    output.placeholder = `Fix the ${inLang()} error to see the output.`;
    setBadge('error', `Error · line ${res.error.line}`);
    nodes.push(errorAlert(res.error));
  } else {
    output.value = res.output;
    setBadge('ok', res.docs > 1 ? `Valid · ${res.docs} docs` : `Valid ${inLang()}`);
    const card = el('div', 'result');
    const meta = el('div', 'result__meta');
    const lines = res.output.split('\n').length - (res.output.endsWith('\n') ? 1 : 0);
    meta.append(el('div', 'result__name', outName()), el('div', 'result__info', `${outLang()} · ${lines} ${lines === 1 ? 'line' : 'lines'} · ${formatBytes(new Blob([res.output]).size)}`));
    card.append(el('span', 'yj-ok', '✓'), meta);
    nodes.push(card);
  }
  res.warnings?.forEach((w) => nodes.push(el('div', 'alert yj-warn', w)));
  res.notes?.forEach((n) => nodes.push(el('div', 'alert yj-note', n)));

  // Only touch the live region when something actually changed, so screen readers are not flooded while typing.
  const sig = nodes.map((n) => n.outerHTML).join('');
  if (results.dataset.sig !== sig) {
    results.replaceChildren(...nodes);
    results.dataset.sig = sig;
  }
  const hasOut = Boolean(output.value);
  copyBtn.disabled = !hasOut;
  downloadBtn.disabled = !hasOut;
  if (reveal && results.firstElementChild) results.firstElementChild.scrollIntoView({ block: 'nearest' });
}

function showProgress(on, label) {
  progress.hidden = !on;
  progress.classList.toggle('is-indeterminate', on);
  if (on) progress.setAttribute('aria-label', label || 'Working');
}

function getWorker() {
  if (!worker) worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return worker;
}

function run({ reveal = false } = {}) {
  clearTimeout(timer);
  const id = ++jobId;
  const text = input.value;
  const opts = options();
  if (text.length < WORKER_THRESHOLD) {
    let res;
    try { res = convert(text, opts); } catch (e) { res = failure(e); }
    showProgress(false);
    render(res, { reveal });
    return;
  }
  setBadge('busy', 'Converting…');
  showProgress(true, `Converting ${formatBytes(text.length)} in the background`);
  let w;
  try { w = getWorker(); } catch (e) {
    showProgress(false);
    render(convert(text, opts), { reveal });
    return;
  }
  w.onmessage = (e) => {
    if (e.data.id !== jobId) return; // a newer edit superseded this job
    showProgress(false);
    render(e.data.failure ? failure(e.data.failure) : e.data.result, { reveal });
  };
  w.onerror = (e) => {
    e.preventDefault();
    worker = null;
    if (id !== jobId) return;
    showProgress(false);
    render(convert(text, opts), { reveal });
  };
  w.postMessage({ id, text, opts });
}

function failure(e) {
  return { ok: false, notes: [], warnings: [], error: { lang: inLang(), message: `Unexpected problem: ${e && e.message || e}`, line: 1, column: 1, position: 0, snippet: '', advice: [] } };
}

function schedule() {
  extraAlerts = [];
  clearTimeout(timer);
  timer = setTimeout(() => run(), DEBOUNCE_MS);
}

function setDirection(dir, { carry = true } = {}) {
  if (dir === direction) return;
  // carry the current result over so the content follows the switch (a round trip)
  if (carry && lastResult?.ok && !lastResult.empty && output.value) input.value = output.value;
  direction = dir;
  updateLabels();
  extraAlerts = [];
  run({ reveal: true });
}

function swap() {
  if (!output.value) {
    toast(lastResult && !lastResult.ok ? `Fix the ${inLang()} error first, then swap.` : 'Nothing to swap yet.');
    return;
  }
  setDirection(direction === 'y2j' ? 'j2y' : 'y2j');
}

async function copy() {
  if (!output.value) return toast('Nothing to copy yet.');
  try {
    await navigator.clipboard.writeText(output.value);
  } catch {
    output.select();
    document.execCommand('copy');
    output.setSelectionRange(0, 0);
  }
  toast(`Copied ${outLang()} (${formatBytes(new Blob([output.value]).size)}) to the clipboard`);
}

function download() {
  if (!output.value) return toast('Nothing to download yet.');
  const type = direction === 'y2j' ? 'application/json' : 'application/yaml';
  downloadBlob(new Blob([output.value], { type: `${type};charset=utf-8` }), outName());
  toast(`Saved ${outName()}`);
}

async function handleFiles(files) {
  const good = files.filter((f) => ACCEPTED.test(f.name));
  const bad = files.filter((f) => !ACCEPTED.test(f.name));
  extraAlerts = bad.map((f) => `${f.name} was not opened: only .yaml, .yml and .json files are supported.`);
  if (good.length > 1) extraAlerts.push(`Only one file at a time: opened ${good[0].name}, skipped ${good.slice(1).map((f) => f.name).join(', ')}.`);
  if (!good.length) {
    render(lastResult || convert(input.value, options()), { reveal: true });
    return;
  }
  const file = good[0];
  if (file.size > WORKER_THRESHOLD) showProgress(true, `Reading ${file.name}`);
  let text;
  try {
    text = await file.text();
  } catch (e) {
    showProgress(false);
    extraAlerts.push(`${file.name} could not be read: ${e.message || e}`);
    render(lastResult || convert('', options()), { reveal: true });
    return;
  }
  fileBase = file.name.replace(/\.[^.]+$/, '') || 'converted';
  direction = /\.json$/i.test(file.name) ? 'j2y' : 'y2j';
  input.value = text;
  updateLabels();
  run({ reveal: true });
  toast(`Opened ${file.name} (${formatBytes(file.size)}), nothing was uploaded`);
}

// ---------- wiring ----------

input.addEventListener('input', schedule);
document.querySelectorAll('input[name="direction"]').forEach((r) => r.addEventListener('change', () => r.checked && setDirection(r.value)));
$('swap').addEventListener('click', swap);
$('convert').addEventListener('click', () => run({ reveal: true }));
copyBtn.addEventListener('click', copy);
downloadBtn.addEventListener('click', download);
Object.values(opt).forEach((o) => o.addEventListener('change', () => run()));

wireDropzone($('dropzone'), $('file-input'), handleFiles);
// The text area itself also accepts dropped files (text drops keep working normally).
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
input.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); input.classList.add('is-dragover'); } });
input.addEventListener('dragleave', () => input.classList.remove('is-dragover'));
input.addEventListener('drop', (e) => {
  input.classList.remove('is-dragover');
  if (!hasFiles(e)) return;
  e.preventDefault();
  handleFiles([...e.dataTransfer.files]);
});

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.key === 'Enter') { e.preventDefault(); run({ reveal: true }); }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); download(); }
});

// Close the options menu with Escape or a click outside it.
const menu = $('options-menu');
document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
menu.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });

// A sample loads on first view so the tool shows what it does right away.
input.value = SAMPLE_YAML;
updateLabels();
run();

// Called by the factory's screenshot script to show the tool in a realistic, fictional state.
window.__demo = async () => {
  const text = await (await fetch('./tests/fixtures/compose.yaml')).text();
  direction = 'y2j';
  fileBase = 'compose';
  input.value = text;
  updateLabels();
  run({ reveal: true });
};

export { handleFiles, convert };
