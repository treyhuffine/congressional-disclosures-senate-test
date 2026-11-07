// Independent browser diagnostic. Fresh installed Edge; ordinary site JS; no session import.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (reason) => {
  throw Object.assign(new Error(reason), { sourceReason: reason });
};
const clock = () => new Date().toISOString();
const contract = require("./all-report-contract.cjs");
const upstream = createRequire(
  path.join(
    process.env.SENATE_UPSTREAM_ROOT || path.join(__dirname, ".."),
    "package.json",
  ),
);
const [outputRoot, mode] = process.argv.slice(2);

async function run(output, fixtureOrigin, suppliedOptions) {
  const options = contract.windowOptions(suppliedOptions);
  const assetHosts = new Set([
    new URL(fixtureOrigin || contract.ORIGIN).origin,
    contract.MEDIA,
  ]);
  const origin = fixtureOrigin || "https://efdsearch.senate.gov";
  if (fixtureOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureOrigin))
    fail("loopback_fixture_required");
  const packageRoot =
    process.env.SENATE_BROWSER_PACKAGE_ROOT ||
    path.join(__dirname, "browser-runtime");
  const load = createRequire(path.join(packageRoot, "package.json"));
  const launcher = load("playwright-extra").addExtra(
    load("rebrowser-playwright-core").chromium,
  );
  const candidates = process.env.SENATE_DIAGNOSTIC_BROWSER
    ? [process.env.SENATE_DIAGNOSTIC_BROWSER]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ]
      : [
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ];
  let executable;
  for (const candidate of candidates)
    try {
      await fs.access(candidate);
      executable = candidate;
      break;
    } catch {}
  if (!executable) fail("installed_browser_required");
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const objects = path.join(output, "objects");
  await fs.mkdir(objects, { mode: 0o700 });
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "senate-diagnostic-profile-"),
  );
  const m = {
    producer: "senate-all-reports-browser-v2",
    fixture_only: !!fixtureOrigin,
    started_at: clock(),
    platform: process.platform,
    runtime: process.version,
    requests: [],
    receipts: [],
    index_passes: [],
    reports: [],
    complete: false,
    session_imported: false,
    session_exported: false,
    headed: true,
    plugin: false,
    lower: options.lower,
    upper: options.upper,
    query_scope: "all_report_types_all_filers",
    index_scans: [],
    assets: [],
    report_failures: [],
    source_retry_count: 0,
    acknowledgements: 0,
  };
  const jobs = new Set(),
    retained = new Map(),
    ids = new Map(),
    latest = new Map();
  const cacheHits = new Set();
  m.index_network = [];
  let pageNumber = 0;
  const mediaResponses = new Map(),
    inReports = new Set();
  async function opened(page) {
    const number = ++pageNumber;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.requestServedFromCache", (e) =>
      cacheHits.add(number + ":" + e.requestId),
    );
    cdp.on("Network.responseReceived", (e) => {
      if (e.response.url === origin + "/search/report/data/")
        m.index_network.push({
          key: number + ":" + e.requestId,
          status: e.response.status,
          from_disk_cache: !!e.response.fromDiskCache,
          from_service_worker: !!e.response.fromServiceWorker,
          from_prefetch_cache: !!e.response.fromPrefetchCache,
          at_utc: clock(),
        });
    });
  }
  let context,
    bytes = 0,
    stopReason,
    timer,
    lastActivity = Date.now();
  const pending = new Set();
  const checkpoint = () =>
    fs.writeFile(
      path.join(output, "checkpoint.json"),
      JSON.stringify(m, null, 2),
      { mode: 0o600 },
    );
  const track = (promise) => {
    jobs.add(promise);
    promise.finally(() => jobs.delete(promise)).catch(() => {});
  };
  async function retain(response) {
    const request = response.request();
    if (retained.has(request)) return retained.get(request);
    const task = (async () => {
      const h = await response.allHeaders();
      const emptyRedirect =
        [301, 302, 303, 307, 308].includes(response.status()) &&
        h["content-length"] === "0";
      const body = emptyRedirect ? Buffer.alloc(0) : await response.body();
      bytes += body.length;
      if (body.length > 64 * 1024 * 1024 || bytes > 256 * 1024 * 1024)
        fail("response_byte_bound");
      const sha256 = hash(body);
      await fs.writeFile(path.join(objects, sha256), body, { mode: 0o600 });
      const r = {
        request_id: ids.get(request),
        url: response.url(),
        method: request.method(),
        status: response.status(),
        at_utc: clock(),
        from_service_worker: response.fromServiceWorker(),
        content_type: h["content-type"] || null,
        bytes: body.length,
        sha256,
        body_observation: emptyRedirect
          ? "observed_empty_redirect"
          : "browser_HTTP_response_body",
      };
      if (h.location)
        r.redirect_to = contract.mediaUrl(h.location, response.url(), origin);
      m.receipts.push(r);
      await checkpoint();
      return r;
    })();
    retained.set(request, task);
    return task;
  }
  async function challenge(page) {
    if (stopReason) fail(stopReason);
    const active = await page
      .evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect(),
            s = getComputedStyle(el);
          return (
            r.width > 0 &&
            r.height > 0 &&
            s.display !== "none" &&
            s.visibility !== "hidden"
          );
        };
        return (
          [
            ...document.querySelectorAll(
              "#sec-if-cpt-container button,#sec-if-cpt-container iframe," +
                '#sec-if-cpt-container input:not([type=hidden]),.g-recaptcha,.h-captcha,iframe[title*="captcha" i]',
            ),
          ].some(visible) ||
          /verify (?:that )?you are human/i.test(document.body?.innerText || "")
        );
      })
      .catch((error) => {
        if (
          /Execution context was destroyed|Cannot find context/.test(
            error.message,
          )
        )
          return false;
        throw error;
      });
    if (active) fail("source_interactive_challenge");
  }
  async function ready(page, predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await challenge(page);
      const response = latest.get(page);
      if (response) {
        const r = await retain(response);
        if ([401, 403].includes(r.status)) fail("source_access_denied");
        if (r.status === 200 && (await predicate().catch(() => false))) return;
      }
      await pause(100);
    }
    fail("source_readiness_deadline");
  }
  const slash = (d) =>
    d.slice(5, 7) + "/" + d.slice(8, 10) + "/" + d.slice(0, 4);
  async function indexResponse(response, pass, expectedStart) {
    const receipt = await retain(response);
    if ([401, 403].includes(receipt.status)) fail("source_access_denied");
    if (
      receipt.status !== 200 ||
      !receipt.content_type?.startsWith("application/json")
    )
      fail("source_index_not_json");
    const page = contract.indexPage(
      JSON.parse(
        (await fs.readFile(path.join(objects, receipt.sha256))).toString(),
      ),
      new URLSearchParams(response.request().postData() || ""),
      m.query_filters,
      options,
      origin,
    );
    if (page.start !== expectedStart) fail("index_page_offset_changed");
    m.index_passes.push({
      ...receipt,
      pass,
      start: page.start,
      total: page.total,
      length: page.length,
    });
    return { ...page, receipt_id: receipt.request_id };
  }
  async function search(page, pass) {
    await challenge(page);
    const again = page.getByRole("button", {
      name: "Search Again",
      exact: true,
    });
    if (await again.isVisible())
      await again.click({ delay: fixtureOrigin ? 0 : 80 });
    const selected = {};
    for (const [name, key] of [
      ["report_type", "report_types"],
      ["filer_type", "filer_types"],
    ]) {
      const boxes = page.locator('input[type=checkbox][name="' + name + '"]'),
        values = [];
      if (!(await boxes.count())) fail("all_report_filter_controls_required");
      for (let i = 0; i < (await boxes.count()); i++) {
        const box = boxes.nth(i),
          value = Number(await box.getAttribute("value"));
        if (!Number.isInteger(value)) fail("unknown_filter_value");
        if (!(await box.isChecked()))
          await box.click({ delay: fixtureOrigin ? 0 : 80 });
        values.push(value);
      }
      const known = name === "report_type" ? [7, 11, 10, 14, 15] : [1, 4, 5];
      if (!known.every((value) => values.includes(value)))
        fail("known_filter_control_missing");
      selected[key] = values;
    }
    if (
      m.query_filters &&
      JSON.stringify(selected) !== JSON.stringify(m.query_filters)
    )
      fail("query_controls_changed");
    m.query_filters = selected;
    for (const [selector, value] of [
      ["#fromDate", slash(options.lower)],
      ["#toDate", slash(options.upper)],
    ]) {
      const field = page.locator(selector);
      await field.click();
      await field.press("ControlOrMeta+A");
      await field.press("Backspace");
      await field.pressSequentially(value, { delay: fixtureOrigin ? 0 : 75 });
    }
    const response = page.waitForResponse(
      (r) => r.url() === origin + "/search/report/data/",
    );
    await page
      .getByRole("button", { name: "Search Reports", exact: true })
      .click({ delay: fixtureOrigin ? 0 : 80 });
    const pages = [await indexResponse(await response, pass, 0)];
    while (pages.reduce((n, p) => n + p.reports.length, 0) < pages[0].total) {
      await challenge(page);
      if (pages.length >= 40) fail("index_page_bound");
      const next = page.waitForResponse(
        (r) => r.url() === origin + "/search/report/data/",
      );
      await page.locator("#filedReports_next").click();
      pages.push(
        await indexResponse(
          await next,
          pass,
          pages.reduce((n, p) => n + p.reports.length, 0),
        ),
      );
    }
    const reports = contract.scanComplete(pages);
    m.index_scans.push({
      pass,
      total: pages[0].total,
      receipt_ids: pages.map((p) => p.receipt_id),
      report_ids: reports.map((r) => r.id),
    });
    return reports;
  }
  async function getAsset(page, asset) {
    if (stopReason) fail(stopReason);
    if (m.assets.length >= options.maxAssets) fail("asset_count_bound");
    let response = mediaResponses.get(asset.url);
    if (!response) {
      const observed = page.waitForResponse((r) => r.url() === asset.url, {
        timeout: 20000,
      });
      const action = page.evaluate(
        async ({ url, image }) => {
          if (image)
            await new Promise((resolve, reject) => {
              const img = new Image();
              img.onload = resolve;
              img.onerror = () => reject(Error("media_image_load_failed"));
              img.src = url;
              document.body.appendChild(img);
            });
          else {
            const r = await fetch(url, { credentials: "same-origin" });
            await r.arrayBuffer();
          }
        },
        {
          url: asset.url,
          image:
            asset.role === "scan_page" ||
            asset.role === "document_image" ||
            /\.(?:png|gif|jpe?g|tiff?)(?:[?#]|$)/i.test(asset.url),
        },
      );
      const both = await Promise.allSettled([observed, action]);
      if (both[0].status !== "fulfilled")
        fail("original_media_response_missing");
      response = both[0].value;
    }
    const redirects = [];
    while ([301, 302, 303, 307, 308].includes(response.status())) {
      if (redirects.length >= 5) fail("media_redirect_bound");
      const r = await retain(response);
      redirects.push(r.request_id);
      if (!r.redirect_to) fail("media_redirect_without_location");
      response =
        mediaResponses.get(r.redirect_to) ||
        (await page.waitForResponse((q) => q.url() === r.redirect_to, {
          timeout: 20000,
        }));
    }
    const receipt = await retain(response);
    if (receipt.status !== 200) fail("source_media_http_error");
    contract.mediaUrl(receipt.url, origin, origin);
    const raw = await fs.readFile(path.join(objects, receipt.sha256)),
      kind = contract.bytesKind(raw, receipt.content_type);
    if (!["pdf", "image"].includes(kind)) fail("unsupported_media_body");
    const recorded = {
      ...asset,
      requested_url: asset.url,
      url: receipt.url,
      redirect_request_ids: redirects,
      kind,
      receipt,
    };
    m.assets.push(recorded);
    return recorded;
  }
  async function reportCapture(entry) {
    if (stopReason) fail(stopReason);
    const report = await context.newPage();
    await opened(report);
    inReports.add(report);
    const record = { ...entry, assets: [], capture_status: "failed" };
    m.reports.push(record);
    try {
      await report.goto(entry.url, {
        waitUntil: "domcontentloaded",
        referer: origin + "/search/",
      });
      await ready(report, () => report.locator("#content").isVisible());
      const receipt = await retain(latest.get(report));
      record.receipt = receipt;
      const raw = await fs.readFile(path.join(objects, receipt.sha256));
      if (contract.bytesKind(raw, receipt.content_type) !== "html")
        fail("report_html_required");
      const body = raw.toString();
      if (
        /<title>[^<]*(?:access denied|error)|<h1>\s*Access Denied/i.test(body)
      )
        fail("source_access_denied");
      const assets = contract.documentAssets(body, entry.url, origin);
      for (const asset of assets)
        record.assets.push(await getAsset(report, asset));
      if (entry.kind === "paper" && !assets.length) fail("paper_pages_missing");
      record.capture_status = "captured";
      record.extraction_status = "pending";
      if (entry.kind === "ptr") {
        try {
          record.transactions = upstream(
            "./packages/congressional-disclosures/dist/sources/senate.js",
          ).parseSenateElectronicPtr(body).length;
        } catch {
          record.extraction_status = "needs_review";
        }
      }
    } catch (error) {
      record.reason = error.sourceReason || "report_capture_error";
      m.report_failures.push({ id: entry.id, reason: record.reason });
      if (
        stopReason ||
        [
          "source_access_denied",
          "source_interactive_challenge",
          "source_supervisor_deadline",
          "response_byte_bound",
          "asset_count_bound",
        ].includes(record.reason)
      )
        throw error;
    } finally {
      inReports.delete(report);
      await report.close().catch(() => {});
    }
  }
  try {
    timer = setTimeout(() => {
      stopReason = "source_supervisor_deadline";
      context?.close().catch(() => {});
    }, options.deadlineMs || 240000);
    context = await launcher.launchPersistentContext(profile, {
      executablePath: executable,
      headless: false,
      chromiumSandbox: true,
      viewport: null,
      acceptDownloads: true,
      slowMo: fixtureOrigin ? 0 : 150,
    });
    m.browser_build = context.browser()?.version() || null;
    m.browser_executable_sha256 = hash(await fs.readFile(executable));
    context.on("request", (request) => {
      pending.add(request);
      lastActivity = Date.now();
      const u = new URL(request.url());
      let reportPage;
      try {
        reportPage = request.frame().page();
      } catch {}
      const media =
        assetHosts.has(u.origin) &&
        inReports.has(reportPage) &&
        ["image", "fetch", "xhr", "other", "document"].includes(
          request.resourceType(),
        );
      if (
        !(
          u.origin === origin &&
          (request.resourceType() === "document" ||
            u.pathname === "/search/report/data/")
        ) &&
        !media
      )
        return;
      const id = m.requests.length + 1;
      ids.set(request, id);
      m.requests.push({
        id,
        url: u.href,
        method: request.method(),
        type: request.resourceType(),
        at_utc: clock(),
      });
      if (m.requests.length > 500) stopReason = "observed_request_bound";
    });
    for (const event of ["requestfinished", "requestfailed"])
      context.on(event, (request) => {
        pending.delete(request);
        lastActivity = Date.now();
      });
    context.on("response", (response) => {
      const request = response.request();
      if (!ids.has(request)) return;
      if (
        request.resourceType() === "document" &&
        request.frame() === request.frame().page().mainFrame()
      )
        latest.set(request.frame().page(), response);
      mediaResponses.set(response.url(), response);
      track(
        retain(response).catch((error) => {
          stopReason ||= error.sourceReason || "response_capture_error";
        }),
      );
    });
    const initial = context.pages(),
      page = await context.newPage();
    await opened(page);
    for (const p of initial) await p.close();
    page.setDefaultTimeout(30000);
    m.browser_defaults = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      webdriver: navigator.webdriver,
      languages: [...navigator.languages],
    }));
    m.stage = "home";
    await page.goto(origin + "/search/home/", { waitUntil: "load" });
    await ready(page, () => page.locator("#agree_statement").isVisible());
    const text = await page.locator("body").innerText();
    if (
      ![
        "news and communications media",
        "credit rating",
        "solicitation of money",
      ].every((x) => text.includes(x))
    )
      fail("source_notice_changed");
    await page.waitForFunction(() => typeof window.jQuery === "function");
    await page.evaluate(() => new Promise((resolve) => window.jQuery(resolve)));
    const box = page.locator("#agree_statement");
    await box.hover();
    const until = Date.now() + (fixtureOrigin ? 0 : 7000);
    while (Date.now() < until) {
      await challenge(page);
      await pause(100);
    }
    const quietDeadline = Date.now() + 10000;
    while (pending.size || Date.now() - lastActivity < 500) {
      await challenge(page);
      if (Date.now() > quietDeadline) {
        m.notice_network_quiet = false;
        m.notice_pending_resources = [...pending].map((q) => {
          const u = new URL(q.url());
          return {
            scheme: u.protocol,
            host: u.hostname,
            path: /^https?:$/.test(u.protocol)
              ? u.pathname.length < 160
                ? u.pathname
                : "<opaque-path>"
              : "<non-http>",
            type: q.resourceType(),
            method: q.method(),
          };
        });
        break;
      }
      await pause(100);
    }
    m.notice_network_quiet ??= true;
    await challenge(page);
    m.stage = "acknowledgement";
    m.acknowledgements = 1;
    const navigation = page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });
    await box.click({ delay: fixtureOrigin ? 0 : 80 });
    await navigation;
    await ready(page, () =>
      page.locator("input[name=report_type]").first().isVisible(),
    );
    m.stage = "index";
    const first = await search(page, 1);
    for (const entry of first) {
      m.stage = "report";
      await reportCapture(entry);
    }
    m.stage = "bookend";
    const second = await search(page, 2);
    contract.sameBookends(first, second);
    if (m.report_failures.length) fail("reports_incomplete");
    await Promise.allSettled([...jobs]);
    await pause(50);
    if (m.index_network.length !== m.index_passes.length)
      fail("index_network_accounting_incomplete");
    for (const item of m.index_network) {
      item.served_from_cache = cacheHits.has(item.key);
      if (
        item.status !== 200 ||
        item.from_disk_cache ||
        item.from_service_worker ||
        item.from_prefetch_cache ||
        item.served_from_cache
      )
        fail("index_not_independent_network_response");
    }
    if (stopReason) fail(stopReason);
    m.complete = true;
    m.stage = "complete";
  } catch (error) {
    m.reason = error.sourceReason || stopReason || "browser_workflow_error";
    m.error_type = error.name;
    m.error_frames = (error.stack || "")
      .split("\n")
      .map((x) => x.match(/browser-client[.]cjs:(\d+):(\d+)/))
      .filter(Boolean)
      .map((x) => ({ line: Number(x[1]), column: Number(x[2]) }));
  } finally {
    clearTimeout(timer);
    m.browser_alive_before_cleanup = context?.browser()?.isConnected() ?? null;
    try {
      await context?.close();
    } catch {
      m.cleanup_error = true;
    }
    await Promise.allSettled([...jobs]);
    await fs.rm(profile, { recursive: true, force: true });
    m.profile_removed = true;
    m.finished_at = clock();
    m.all_requests_accounted = m.requests.every((q) =>
      m.receipts.some((r) => r.request_id === q.id),
    );
    if (!m.all_requests_accounted || stopReason || m.cleanup_error) {
      m.complete = false;
      m.reason ||= stopReason || "response_or_cleanup_accounting_incomplete";
      m.stage = "incomplete";
    }
    await fs.writeFile(
      path.join(output, "manifest.json"),
      JSON.stringify(m, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  return m;
}

module.exports = { run };
if (require.main === module) {
  const options = JSON.parse(process.env.SENATE_COLLECTION_OPTIONS || "{}");
  fs.mkdir(outputRoot, { recursive: true, mode: 0o700 })
    .then(() => run(path.join(outputRoot, "capture"), undefined, options))
    .then((result) => {
      console.log(
        JSON.stringify({
          complete: result.complete,
          reason: result.reason,
          reports: result.reports.length,
          index_pages: result.index_passes.length,
          failed_reports: result.report_failures.length,
        }),
      );
      process.exitCode = result.complete ? 0 : 1;
    })
    .catch((error) => {
      console.error(error.sourceReason || error.name);
      process.exitCode = 1;
    });
}
