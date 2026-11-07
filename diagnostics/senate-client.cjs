// Execute the actual compiled upstream source client. Only the outer harness adds
// limits, original-response capture, fixture URL mapping and zero-retry policy.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const [codeRoot, outputRoot, classifier, python, mode] = process.argv.slice(2);
const origin = 'https://efdsearch.senate.gov';
const ptr = '/search/view/ptr/a89c0c6b-4c12-4955-98f9-3a54ca52d8a3/';
const actualFetch = globalThis.fetch;
const httpModule = require(path.join(codeRoot, 'packages/congressional-disclosures/dist/sources/http.js'));
const originalRetry = httpModule.fetchWithRetry;
httpModule.fetchWithRetry = (url, init, opts = {}) => originalRetry(url, init, { ...opts, retries: 0, timeoutMs: 8000 });
const { SenateEfdSession, parseSenateElectronicPtr } = require(path.join(codeRoot, 'packages/congressional-disclosures/dist/sources/senate.js'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const stop = reason => { throw Object.assign(new Error(reason), { sourceReason: reason }); };

async function run(kind, fixtureOrigin) {
  const output = path.join(outputRoot, kind);
  fs.mkdirSync(output, { mode: 0o700 });
  fs.mkdirSync(path.join(output, 'objects'), { mode: 0o700 });
  const started = Date.now();
  let bytes = 0, session;
  const m = { producer: 'senate-exact-repo-http-diagnostic', fixture_only: !!fixtureOrigin,
    native_qualified: false, upstream_commit: '2965e8796bd4cb9423a83b964a1f9dbd076a0ad6',
    runtime: process.version, openssl: process.versions.openssl, undici: process.versions.undici,
    started_at: new Date().toISOString(), requests: [], receipts: [], indexes: [], reports: [],
    source_retries: 0, acknowledgements: 0, complete: false, session_state_imported: false,
    session_state_exported: false, stage: 'home', query_start: '11/04/2026',
    capture_date_upper_bound: '2026-11-06', source_query_end: 'upstream default blank',
    bounds: { requests: 10, seconds: 120, per_response_bytes: 4194304, reports: 5 },
  };
  const checkpoint = () => write(path.join(output, 'checkpoint.json'), m);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== origin || url.search || url.hash ||
      !(/^\/search\/(?:home\/|report\/data\/|view\/ptr\/[0-9a-f-]{36}\/)$/.test(url.pathname)))
      stop('unexpected_source_target');
    if (m.requests.length >= 10 || Date.now() - started > 120000) stop('request_or_time_bound');
    const method = init.method || 'GET', isAck = method === 'POST' && url.pathname === '/search/home/';
    if (isAck && ++m.acknowledgements > 1) stop('acknowledgement_bound');
    m.stage = isAck ? 'acknowledgement' : url.pathname === '/search/home/' ? 'home' :
      url.pathname === '/search/report/data/' ? 'index' : 'report';
    const id = m.requests.length + 1;
    const headers = new Headers(init.headers);
    m.requests.push({ id, method, url: url.href, at_utc: new Date().toISOString(),
      header_names: [...headers.keys()].sort(), user_agent: headers.get('user-agent'),
      form_field_names: init.body instanceof URLSearchParams ? [...init.body.keys()].sort() : [] });
    checkpoint();
    const target = fixtureOrigin ? fixtureOrigin + url.pathname : url;
    const response = await actualFetch(target, { ...init, redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(100, Math.min(8000, 120000 - (Date.now() - started)))) });
    const clone = response.clone(), pieces = [];
    let size = 0;
    if (clone.body) for await (const piece of clone.body) {
      size += piece.length;
      if (size > 4194304 || bytes + size > 16777216) stop('response_body_bound');
      pieces.push(piece);
    }
    const body = Buffer.concat(pieces); bytes += body.length;
    const sha256 = hash(body);
    fs.writeFileSync(path.join(output, 'objects', sha256), body, { mode: 0o600 });
    const location = response.headers.get('location');
    m.receipts.push({ request_id: id, method, url: url.href, at_utc: new Date().toISOString(),
      status: response.status, content_type: response.headers.get('content-type'),
      bytes: body.length, sha256, location: location ? new URL(location, origin).pathname : null,
      observation: 'Node_fetch_decoded_original_HTTP_body', wire_hash_available: false });
    checkpoint();
    if ([401, 403].includes(response.status)) stop('source_access_denied');
    const code = "import importlib.util,sys;s=importlib.util.spec_from_file_location('c',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.document_kind(sys.stdin.buffer.read()))";
    const classification = execFileSync(python, ['-c', code, classifier], { input: body, timeout: 5000 }).toString().trim();
    if (classification === 'interactive_challenge') stop('source_interactive_challenge');
    if (classification === 'protection') stop('source_protection_without_JS');
    if (response.status === 302) {
      if (!isAck || new URL(location, origin).href !== origin + '/search/') stop('unexpected_redirect');
    } else if (response.status !== 200) stop('unexpected_http_status');
    if (url.pathname === '/search/report/data/') {
      const value = JSON.parse(body);
      if (value.result !== 'ok' || !Number.isInteger(value.recordsFiltered) ||
          value.recordsFiltered < 0 || value.recordsFiltered > 5 ||
          !Array.isArray(value.data) || value.data.length !== value.recordsFiltered)
        stop('bounded_exhausted_index_required');
      for (const row of value.data) {
        const d = row[4]?.match(/^(\d\d)\/(\d\d)\/(\d{4})$/);
        const day = d && d[3] + '-' + d[1] + '-' + d[2];
        if (!day || day < '2026-11-04' || day > '2026-11-06') stop('source_row_outside_capture_window');
      }
      m.indexes.push(id);
    }
    return response;
  };
  try {
    session = await SenateEfdSession.open(true);
    const ack = m.receipts.find(r => r.method === 'POST' && r.url.endsWith('/search/home/'));
    if (ack?.status !== 302 || !session.cookies?.has('sessionid')) stop('agreement_not_established');
    const first = await session.searchPeriodicTransactionReports('11/04/2026');
    if (first.length > 5) stop('report_bound');
    for (const row of first) {
      if (!/^\/search\/view\/ptr\/[0-9a-f-]{36}\/$/.test(row.reportPath)) stop('unexpected_report_kind');
      const html = await session.fetchReportHtml(row.reportPath);
      const transactions = parseSenateElectronicPtr(html);
      if (!transactions.length) stop('empty_transaction_report');
      m.reports.push({ report_path: row.reportPath, transactions: transactions.length });
    }
    const second = await session.searchPeriodicTransactionReports('11/04/2026');
    if (JSON.stringify(first) !== JSON.stringify(second) || m.indexes.length !== 2)
      stop('independent_index_bookend_mismatch');
    m.complete = true; m.stage = 'complete';
  } catch (e) {
    m.reason = e.sourceReason || 'upstream_or_protocol_error'; m.error_type = e.name;
  } finally {
    session?.cookies?.clear(); session = null;
    m.session_object_discarded = true;
    m.all_requests_accounted = m.requests.length === m.receipts.length;
    m.finished_at = new Date().toISOString();
    write(path.join(output, 'manifest.json'), m);
    globalThis.fetch = actualFetch;
  }
  return m;
}

async function fixtures() {
  const outcomes = [];
  for (const kind of ['success', 'denied', 'protection', 'challenge']) {
    const seen = [], errors = [];
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      seen.push([req.method, req.url]);
      if (req.headers['user-agent'] !== 'congressional-disclosures/0.2') errors.push('UA changed');
      if (req.headers.origin) errors.push('unexpected explicit Origin');
      res.setHeader('content-type', 'text/html');
      if (req.method === 'GET' && req.url === '/search/home/') {
        res.setHeader('set-cookie', 'csrftoken=FIXTURE_CSRF_SECRET; Path=/');
        res.end('<input name="csrfmiddlewaretoken" value="FIXTURE_CSRF_SECRET">');
      } else if (req.method === 'POST' && req.url === '/search/home/') {
        if (form.get('prohibition_agreement') !== '1' || form.get('csrfmiddlewaretoken') !== 'FIXTURE_CSRF_SECRET' ||
          !req.headers.cookie?.includes('csrftoken=FIXTURE_CSRF_SECRET')) errors.push('fresh agreement mismatch');
        if (kind === 'denied') { res.statusCode = 403; res.end('<h1>Access Denied</h1>'); }
        else if (kind === 'protection') res.end('<div id="sec-if-cpt-container"></div>');
        else if (kind === 'challenge') res.end('<div id="sec-if-cpt-container"><button>Verify</button></div>');
        else { res.statusCode = 302; res.setHeader('location', '/search/');
          res.setHeader('set-cookie', 'sessionid=FIXTURE_SESSION_SECRET; Path=/'); res.end(); }
      } else if (req.method === 'POST' && req.url === '/search/report/data/') {
        if (!req.headers.cookie?.includes('sessionid=FIXTURE_SESSION_SECRET') ||
          form.get('csrfmiddlewaretoken') !== 'FIXTURE_CSRF_SECRET' ||
          form.get('report_types') !== '[11]' || form.get('filer_types') !== '[]') errors.push('index mismatch');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result: 'ok', recordsFiltered: 1, recordsTotal: 1,
          data: [['Fixture', 'Only', 'Fixture', '<a href="' + ptr + '">PTR</a>', '11/04/2026']] }));
      } else if (req.method === 'GET' && req.url === ptr) {
        res.end('<table><thead><tr>' + ['#','Transaction Date','Owner','Ticker','Asset Name','Asset Type','Type','Amount','Comment'].map(x => '<th>' + x + '</th>').join('') +
          '</tr></thead><tbody><tr>' + ['1','11/01/2026','Self','TEST','Fixture Only','Stock','Purchase','$1,001 - $15,000','--'].map(x => '<td>' + x + '</td>').join('') + '</tr></tbody></table>');
      } else { errors.push('unexpected target'); res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let result;
    try { result = await run(kind, 'http://127.0.0.1:' + server.address().port); }
    finally { await new Promise(resolve => server.close(resolve)); }
    if (errors.length) throw Error(errors.join(', '));
    const expected = { denied: 'source_access_denied', protection: 'source_protection_without_JS', challenge: 'source_interactive_challenge' };
    if (!result.all_requests_accounted || (kind === 'success' ?
      !result.complete || seen.length !== 5 || result.reports.length !== 1 :
      result.reason !== expected[kind] || seen.length !== 2)) throw Error('fixture failed: ' + kind);
    if (JSON.stringify(result).includes('FIXTURE_CSRF_SECRET') || JSON.stringify(result).includes('FIXTURE_SESSION_SECRET'))
      throw Error('fixture secret leaked into manifest');
    outcomes.push({ kind, passed: true, requests: seen.length });
  }
  write(path.join(outputRoot, 'FIXTURES_PASSED.json'), outcomes);
}
fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
write(path.join(outputRoot, 'RUNTIME.json'), { node: process.version, openssl: process.versions.openssl, undici: process.versions.undici });
(mode === 'fixtures' ? fixtures() : run('capture')).then(result => {
  if (mode !== 'fixtures') { console.log(JSON.stringify({complete:result.complete,stage:result.stage,reason:result.reason,statuses:result.receipts.map(r=>r.status),indexes:result.indexes.length,reports:result.reports.length,runtime:result.runtime})); process.exitCode = result.complete ? 0 : 1; }
}).catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
