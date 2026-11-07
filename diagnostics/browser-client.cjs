// Independent browser diagnostic. Fresh installed Edge; ordinary site JS; no session import.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = reason => { throw Object.assign(new Error(reason), { sourceReason: reason }); };
const clock = () => new Date().toISOString();
const [outputRoot, mode] = process.argv.slice(2);

async function run(output, fixtureOrigin) {
  const origin = fixtureOrigin || 'https://efdsearch.senate.gov';
  if (fixtureOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureOrigin)) fail('loopback_fixture_required');
  const packageRoot = process.env.SENATE_BROWSER_PACKAGE_ROOT || path.join(__dirname, 'browser-runtime');
  const load = createRequire(path.join(packageRoot, 'package.json'));
  const launcher = load('playwright-extra').addExtra(load('rebrowser-playwright-core').chromium);
  const candidates = process.env.SENATE_DIAGNOSTIC_BROWSER ? [process.env.SENATE_DIAGNOSTIC_BROWSER] :
    ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
  let executable;
  for (const candidate of candidates) try { await fs.access(candidate); executable = candidate; break; } catch {}
  if (!executable) fail('installed_browser_required');
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const objects = path.join(output, 'objects');
  await fs.mkdir(objects, { mode: 0o700 });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'senate-diagnostic-profile-'));
  const m = { producer: 'senate-browser-response-diagnostic', fixture_only: !!fixtureOrigin,
    started_at: clock(), platform: process.platform, runtime: process.version,
    requests: [], receipts: [], index_passes: [], reports: [], complete: false,
    session_imported: false, session_exported: false, headed: true, plugin: false,
    lower: '2026-11-04', upper: '2026-11-05', source_retry_count: 0, acknowledgements: 0 };
  const jobs = new Set(), retained = new Map(), ids = new Map(), latest = new Map();
  const cacheHits=new Set();m.index_network=[];let pageNumber=0;
  async function opened(page){const number=++pageNumber;const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');cdp.on('Network.requestServedFromCache',e=>cacheHits.add(number+':'+e.requestId));cdp.on('Network.responseReceived',e=>{if(e.response.url===origin+'/search/report/data/')m.index_network.push({key:number+':'+e.requestId,status:e.response.status,from_disk_cache:!!e.response.fromDiskCache,from_service_worker:!!e.response.fromServiceWorker,from_prefetch_cache:!!e.response.fromPrefetchCache,at_utc:clock()});});}
  let context, bytes = 0, stopReason, timer, lastActivity=Date.now();const pending=new Set();
  const checkpoint = () => fs.writeFile(path.join(output, 'checkpoint.json'), JSON.stringify(m, null, 2), { mode: 0o600 });
  const track = promise => { jobs.add(promise); promise.finally(() => jobs.delete(promise)).catch(() => {}); };
  async function retain(response) {
    const request = response.request();
    if (retained.has(request)) return retained.get(request);
    const task = (async () => {
      const h = await response.allHeaders();
      const emptyRedirect = [301,302,303,307,308].includes(response.status()) && h['content-length'] === '0';
      const body = emptyRedirect ? Buffer.alloc(0) : await response.body();
      bytes += body.length;
      if (body.length > 4*1024*1024 || bytes > 16*1024*1024) fail('response_byte_bound');
      const sha256 = hash(body);
      await fs.writeFile(path.join(objects, sha256), body, { mode: 0o600 });
      const r = { request_id: ids.get(request), url: response.url(), method: request.method(),
        status: response.status(), at_utc: clock(), from_service_worker:response.fromServiceWorker(), content_type: h['content-type'] || null,
        bytes: body.length, sha256, body_observation: emptyRedirect ? 'observed_empty_redirect' : 'browser_HTTP_response_body' };
      m.receipts.push(r); await checkpoint(); return r;
    })();
    retained.set(request, task);
    return task;
  }
  async function challenge(page) {
    if (stopReason) fail(stopReason);
    const active = await page.evaluate(() => {
      const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el);
        return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
      return [...document.querySelectorAll('#sec-if-cpt-container button,#sec-if-cpt-container iframe,'+
        '#sec-if-cpt-container input:not([type=hidden]),.g-recaptcha,.h-captcha,iframe[title*="captcha" i]')].some(visible)
        || /verify (?:that )?you are human/i.test(document.body?.innerText || '');
    }).catch(error => { if (/Execution context was destroyed|Cannot find context/.test(error.message)) return false; throw error; });
    if (active) fail('source_interactive_challenge');
  }
  async function ready(page, predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await challenge(page);
      const response = latest.get(page);
      if (response) {
        const r = await retain(response);
        if ([401,403].includes(r.status)) fail('source_access_denied');
        if (r.status === 200 && await predicate().catch(() => false)) return;
      }
      await pause(100);
    }
    fail('source_readiness_deadline');
  }
  function rows(value) {
    const count = value.recordsFiltered, data = value.data;
    if (!Number.isInteger(count) || count<0 || count>5 || !Array.isArray(data) || data.length!==count)
      fail('bounded_exhausted_index_required');
    for (const row of data) if (!Array.isArray(row) || row.length!==5 ||
      !['11/04/2026','11/05/2026'].includes(row[4]) ||
      !/href=["']\/search\/view\/ptr\/[0-9a-f-]{36}\/["']/.test(row[3])) fail('source_row_scope_changed');
    return data;
  }
  async function search(page) {
    await challenge(page);
    const again = page.getByRole('button', { name: 'Search Again', exact: true });
    if (await again.isVisible()) await again.click({ delay: fixtureOrigin ? 0 : 80 });
    const periodic = page.getByLabel('Periodic Transactions', { exact: true });
    if (!await periodic.isChecked()) await periodic.click({ delay: fixtureOrigin ? 0 : 80 });
    for (const [selector, value] of [['#fromDate','11/04/2026'],['#toDate','11/05/2026']]) {
      const field = page.locator(selector); await field.click();
      await field.press('ControlOrMeta+A'); await field.press('Backspace');
      await field.pressSequentially(value, { delay: fixtureOrigin ? 0 : 75 });
    }
    const wait = page.waitForResponse(r => r.url() === origin+'/search/report/data/');
    await page.getByRole('button', { name: 'Search Reports', exact: true }).click({ delay: fixtureOrigin ? 0 : 80 });
    const response = await wait, receipt = await retain(response);
    if ([401,403].includes(receipt.status)) fail('source_access_denied');
    if (receipt.status!==200) fail('source_index_http_error');
    if(!receipt.content_type?.startsWith('application/json'))fail('source_index_not_json');
    const data = rows(JSON.parse((await fs.readFile(path.join(objects, receipt.sha256))).toString()));
    m.index_passes.push(receipt); return data;
  }
  try {
    timer = setTimeout(() => { stopReason='source_supervisor_deadline'; context?.close().catch(()=>{}); },225000);
    context = await launcher.launchPersistentContext(profile, { executablePath: executable, headless: false,
      chromiumSandbox: true, viewport: null, acceptDownloads: false, slowMo: fixtureOrigin ? 0 : 150 });
    context.on('request', request => {
      pending.add(request);lastActivity=Date.now();
      const u = new URL(request.url());
      if (u.origin!==origin || !(request.resourceType()==='document' || u.pathname==='/search/report/data/')) return;
      const id=m.requests.length+1;ids.set(request,id);
      m.requests.push({ id, url:u.origin+u.pathname, method:request.method(), type:request.resourceType(), at_utc:clock() });
      if (m.requests.length>25) stopReason='observed_request_bound';
    });
    for(const event of ['requestfinished','requestfailed'])context.on(event,request=>{pending.delete(request);lastActivity=Date.now();});
    context.on('response', response => {
      const request=response.request();
      if (!ids.has(request)) return;
      if (request.resourceType()==='document') latest.set(request.frame().page(),response);
      track(retain(response).catch(error => { stopReason ||= error.sourceReason || 'response_capture_error'; }));
    });
    const initial = context.pages(), page = await context.newPage();await opened(page);
    for (const p of initial) await p.close();
    page.setDefaultTimeout(30000);
    m.browser_defaults=await page.evaluate(()=>({userAgent:navigator.userAgent,platform:navigator.platform,webdriver:navigator.webdriver,languages:[...navigator.languages]}));
    m.stage='home';
    await page.goto(origin+'/search/home/',{waitUntil:'load'});
    await ready(page,()=>page.locator('#agree_statement').isVisible());
    const text=await page.locator('body').innerText();
    if (!['news and communications media','credit rating','solicitation of money'].every(x=>text.includes(x)))
      fail('source_notice_changed');
    await page.waitForFunction(()=>typeof window.jQuery==='function');
    await page.evaluate(()=>new Promise(resolve=>window.jQuery(resolve)));
    const box=page.locator('#agree_statement');await box.hover();
    const until=Date.now()+(fixtureOrigin?0:7000);
    while(Date.now()<until){await challenge(page);await pause(100);}
    const quietDeadline=Date.now()+10000;while(pending.size||Date.now()-lastActivity<500){await challenge(page);if(Date.now()>quietDeadline)fail('notice_network_not_quiet');await pause(100);}
    await challenge(page);m.stage='acknowledgement';m.acknowledgements=1;
    const navigation=page.waitForNavigation({waitUntil:'domcontentloaded'});
    await box.click({delay:fixtureOrigin?0:80});await navigation;
    await ready(page,()=>page.getByLabel('Periodic Transactions',{exact:true}).isVisible());
    m.stage='index';const first=await search(page);
    for(const row of first){
      m.stage='report';const reportPath=row[3].match(/href=["']([^"']+)["']/)[1];
      const report=await context.newPage();await opened(report);await report.goto(origin+reportPath,{waitUntil:'domcontentloaded',referer:origin+'/search/'});
      await ready(report,()=>report.getByRole('heading',{name:/Periodic Transaction Report/}).isVisible());
      const receipt=await retain(latest.get(report)),body=(await fs.readFile(path.join(objects,receipt.sha256))).toString();
      const transactions=fixtureOrigin ? (body.includes('Transaction Date')?1:0) :
        require('../packages/congressional-disclosures/dist/sources/senate.js').parseSenateElectronicPtr(body).length;
      if(!transactions)fail('nonempty_report_table_required');
      m.reports.push({source_row:row,receipt,transactions});await report.close();
    }
    m.stage='bookend';const second=await search(page);
    if(JSON.stringify(first)!==JSON.stringify(second))fail('source_index_bookend_changed');
    await Promise.allSettled([...jobs]);
    await pause(50);
    if(m.index_network.length!==m.index_passes.length)fail('index_network_accounting_incomplete');
    for(const item of m.index_network){item.served_from_cache=cacheHits.has(item.key);if(item.status!==200||item.from_disk_cache||item.from_service_worker||item.from_prefetch_cache||item.served_from_cache)fail('index_not_independent_network_response');}
    if(stopReason)fail(stopReason);
    m.complete=true;m.stage='complete';
  } catch(error) { m.reason=error.sourceReason||stopReason||'browser_workflow_error';m.error_type=error.name;m.error_frames=(error.stack||'').split('\n').map(x=>x.match(/browser-client[.]cjs:(\d+):(\d+)/)).filter(Boolean).map(x=>({line:Number(x[1]),column:Number(x[2])})); }
  finally{
    clearTimeout(timer);m.browser_alive_before_cleanup=context?.browser()?.isConnected()??null;
    try{await context?.close();}catch{m.cleanup_error=true;}
    await Promise.allSettled([...jobs]);await fs.rm(profile,{recursive:true,force:true});
    m.profile_removed=true;m.finished_at=clock();m.all_requests_accounted=m.requests.every(q=>m.receipts.some(r=>r.request_id===q.id));
    await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(m,null,2)+'\n',{mode:0o600});
  }
  return m;
}

async function fixtures() {
  const results=[],ptr='/search/view/ptr/a89c0c6b-4c12-4955-98f9-3a54ca52d8a3/';
  for(const mode of ['normal','intermediate','challenge']){
    let acknowledgements=0,indexes=0;
    const server=http.createServer(async(req,res)=>{
      for await(const _ of req){}
      res.setHeader('content-type','text/html');
      if(req.url==='/search/home/'&&req.method==='GET')res.end('<form method="POST"><label><input id="agree_statement" type="checkbox" onclick="this.form.submit()">Agree</label></form><p>news and communications media; credit rating; solicitation of money</p><script>window.jQuery=f=>f()</script>');
      else if(req.url==='/search/home/'){acknowledgements++;if(mode==='normal'){res.writeHead(302,{'location':'/ready','content-length':'0'});res.end();}else res.end(mode==='intermediate'?'<form name="sec_sbsd_chlge_form"></form><div id="sec-if-cpt-container"></div><script>setTimeout(()=>location.href="/ready",200)</script>':'<div id="sec-if-cpt-container"></div><script>setTimeout(()=>document.querySelector("div").innerHTML="<button>Verify</button>",200)</script>');}
      else if(req.url==='/ready')res.end('<label>Periodic Transactions<input type="checkbox"></label><input id="fromDate"><input id="toDate"><button id="again" style="display:none" onclick="this.style.display=\'none\'">Search Again</button><button onclick="fetch(\'/search/report/data/\',{method:\'POST\'}).then(r=>r.json()).then(()=>document.getElementById(\'again\').style.display=\'inline\')">Search Reports</button>');
      else if(req.url==='/search/report/data/'){indexes++;res.setHeader('content-type','application/json');res.end(JSON.stringify({recordsFiltered:1,data:[['Fixture','Senator','Fixture','<a href="'+ptr+'">PTR</a>','11/04/2026']]}));}
      else if(req.url===ptr)res.end('<h1>Periodic Transaction Report</h1><table><th>Transaction Date</th><td>Fixture</td></table>');
      else{res.statusCode=404;res.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    let result;
    try{result=await run(path.join(outputRoot,mode),'http://127.0.0.1:'+server.address().port);}
    finally{await new Promise(resolve=>server.close(resolve));}
    if(acknowledgements!==1||!result.profile_removed||!result.all_requests_accounted)throw Error('fixture accounting failed');
    if(mode==='challenge'?(result.reason!=='source_interactive_challenge'||indexes!==0):(!result.complete||indexes!==2||result.reports.length!==1))
      throw Error('browser fixture failed: '+mode);
    results.push({mode,passed:true,source_requests:0});
  }
  await fs.writeFile(path.join(outputRoot,'FIXTURES_PASSED.json'),JSON.stringify(results,null,2)+'\n');
}
fs.mkdir(outputRoot,{recursive:true,mode:0o700}).then(()=>mode==='fixtures'?fixtures():run(path.join(outputRoot,'capture'))).then(result=>{
  if(mode!=='fixtures'){console.log(JSON.stringify({complete:result.complete,reason:result.reason,statuses:result.receipts.map(r=>r.status),indexes:result.index_passes.length,reports:result.reports.length}));process.exitCode=result.complete?0:1;}
}).catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;});
