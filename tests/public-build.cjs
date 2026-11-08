'use strict';

// Audit the public offline artifact and execute the real import-routing
// functions. This test never reads user documents or performs network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const candidates = ['dist/index.html', 'index.html'];
const artifact = process.argv[2]
  ? path.resolve(ROOT, process.argv[2])
  : candidates.map(file => path.join(ROOT, file)).find(file => fs.existsSync(file));
assert(artifact && fs.existsSync(artifact), 'Build the public HTML before running this check.');
const html = fs.readFileSync(artifact, 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
const checks = [];
function check(name, action) { action(); checks.push(name); console.log('PASS ' + name); }

check('the public artifact bundles only the supported local document adapters', () => {
  for (const id of ['psd-worker-source', 'demo-psd-data', 'image-adapter-source', 'svg-adapter-source', 'filters-source']) {
    assert(new RegExp(`\\bid=["']${id}["']`).test(html), `Missing bundled ${id}`);
  }
  const excluded = [
    ['AI adapter', /LayerDeskAi(?:Document|Native)|ai-(?:adapter|native-worker|postscript|router)-source/i],
    // The PSD parser legitimately attributes CMYK conversion coefficients to
    // Mozilla's PDF.js. Runtime IDs/globals are distinct from that attribution.
    ['PDF runtime', /pdfjs-(?:source|worker-source|assets-data)|pdfjsLib|pdfjs-dist|pdf\.worker\.(?:min\.)?mjs|pdf-runtime\.js/i],
    ['PGF parser', /illustrator-pgf|ai-native-runtime\.js/i],
    ['Zstandard parser', /\bfzstd\b/i],
    ['PostScript runtime', /ghostscript|ai-postscript-runtime\.js/i],
  ];
  for (const [name, expression] of excluded) assert(!expression.test(html), `${name} remains in the public artifact`);
  for (const file of ['vendor/pdfjs', 'vendor/illustrator-pgf', 'vendor/fzstd', 'vendor/ghostscript', 'src/ai.js', 'src/ai-native.js', 'src/pdf-runtime.js', 'src/ai-native-runtime.js', 'src/ai-postscript-runtime.js']) {
    assert(!fs.existsSync(path.join(ROOT, file)), `Excluded runtime still ships at ${file}`);
  }
});

check('the artifact stays offline and advertises supported inputs', () => {
  assert(/connect-src\s+'none'/.test(html), 'The offline CSP must block network connections.');
  assert(!/<script\b[^>]*\bsrc\s*=/i.test(html), 'A runtime script still needs a separate or remote file.');
  const fileInput = html.match(/<input\b[^>]*\bid=["']file-input["'][^>]*>/i)?.[0];
  assert(fileInput, 'Missing file input.');
  const accept = fileInput.match(/\baccept=["']([^"']*)["']/i)?.[1] || '';
  assert(accept.includes('.psd') && accept.includes('.psb') && accept.includes('.svg') && accept.includes('image/'), 'Supported document types are missing.');
  assert(!/(?:^|,)\s*\.(?:ai|pdf)(?:\s*,|$)/i.test(accept), 'The input still advertises excluded formats.');
  assert(!/\bid=["']ai-artboard-(?:control|select)["']/i.test(html), 'An unsupported artboard selector remains.');
});

check('the toolbar contains implemented controls rather than placeholder tools', () => {
  const rail = html.match(/<aside\b[^>]*\bclass=["'][^"']*\btool-rail\b[^"']*["'][^>]*>([\s\S]*?)<\/aside>/i)?.[1];
  assert(rail, 'Missing canvas toolbar.');
  const ids = [...rail.matchAll(/<button\b[^>]*\bid=["']([^"']+)["']/gi)].map(match => match[1]);
  assert.deepEqual(ids.sort(), ['tool-select', 'tool-hand', 'tool-zoom', 'fit-btn', 'actual-btn'].sort());
  for (const id of ids) assert(app.includes(`$('${id}').onclick`), `${id} is visible without an event handler.`);
  const markup = html.split(/<script\b/i)[0];
  assert(!/data-placeholder|coming-soon|敬请期待|功能即将/i.test(markup), 'Placeholder controls remain in the public UI.');
  assert(!/<a\b[^>]*\bhref=["']#["']/i.test(markup), 'A placeholder link remains in the public UI.');
});

function applicationFunction(name) {
  // Functions are extracted verbatim from the application, rather than
  // reimplementing its extension/MIME rules in the test.
  const declaration = app.match(new RegExp(`^  function ${name}\\([^\\n]*\\)\\s*\\{[\\s\\S]*?^  \\}`, 'm'))?.[0];
  assert(declaration, `Cannot find the application's ${name} function.`);
  return declaration;
}

check('AI and PDF imports are rejected before any document or backend is opened', () => {
  const sessions = [], notices = [];
  let imports = 0, documentStates = 0;
  const sandbox = vm.createContext({
    sessions, documentSequence: 0,
    renderTabs() {}, toast(message) { notices.push(message); },
    createState() { documentStates++; return {}; },
    drainImports() { imports++; }, activateSession() {},
    fetch() { throw new Error('Network access is forbidden in this check.'); },
    Worker() { throw new Error('A rejected file must not create a Worker.'); },
  });
  vm.runInContext(`${applicationFunction('fileKind')}\n${applicationFunction('openFiles')}`, sandbox);
  const excluded = [
    { name: 'unsupported.ai', type: 'application/postscript' },
    { name: 'UPPERCASE.AI', type: 'image/png' },
    { name: 'unsupported.pdf', type: 'application/pdf' },
    { name: 'mislabelled.png', type: 'application/pdf' },
    { name: 'mislabelled.svg', type: 'application/postscript' },
    { name: 'no-extension', type: 'application/illustrator' },
  ];
  for (const entry of excluded) {
    const file = { ...entry, size: 128, lastModified: 0,
      arrayBuffer() { throw new Error('Rejected files must not be read.'); },
      slice() { throw new Error('Rejected files must not be decoded.'); },
    };
    assert.equal(sandbox.fileKind(file), null, `Accepted excluded input ${file.name}`);
    sandbox.openFiles([file]);
  }
  assert.equal(sessions.length, 0, 'Rejected files created document tabs.');
  assert.equal(documentStates, 0, 'Rejected files allocated document state.');
  assert.equal(imports, 0, 'Rejected files reached the import queue.');
  assert.equal(notices.length, excluded.length, 'Rejections did not produce a readable notice.');
  assert(notices.every(message => /PSD/.test(message) && /SVG/.test(message)), 'Rejection notices do not describe the supported formats.');
  for (const [name, type, expected] of [
    ['sample.psd', 'application/octet-stream', 'psd'],
    ['sample.psb', 'application/octet-stream', 'psd'],
    ['sample.svg', 'image/svg+xml', 'svg'],
    ['sample.png', 'image/png', 'image'],
    ['sample.jpg', 'image/jpeg', 'image'],
    ['sample.webp', 'image/webp', 'image'],
  ]) assert.equal(sandbox.fileKind({ name, type }), expected, `Rejected supported input ${name}`);
});

console.log(JSON.stringify({ passed: checks.length, artifact: path.relative(ROOT, artifact), checks }, null, 2));
