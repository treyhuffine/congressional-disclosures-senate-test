// Actual Chromium loopback fixtures. Synthetic originals never qualify live-source evidence.
const assert = require("node:assert/strict"),
  http = require("node:http"),
  fs = require("node:fs/promises"),
  path = require("node:path");
const { PDFDocument, StandardFonts } = require("pdf-lib"),
  sharp = require("sharp");
const { run } = require("./all-reports.cjs"),
  contract = require("./all-report-contract.cjs");
const root = process.argv[2];
const options = {
  lower: "2026-11-02",
  upper: "2026-11-06",
  maxReports: 20,
  maxAssets: 20,
  deadlineMs: 45000,
};
const ids = [1, 2, 3].map(
  (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0"),
);
const paths = ["ptr", "annual", "paper"].map(
  (kind, i) => "/search/view/" + kind + "/" + ids[i] + "/",
);
const data = paths.map((p, i) => [
  "Fixture",
  "Senator",
  "Fixture Senator",
  `<a href="${p}">${i === 0 ? "Periodic Transaction Report" : i === 1 ? "Annual Financial Disclosure" : "Periodic Transaction Report (Amendment)"}</a>`,
  "11/04/2026",
]);
const headers = [
  "#",
  "Transaction Date",
  "Owner",
  "Ticker",
  "Asset Name",
  "Asset Type",
  "Type",
  "Amount",
  "Comment",
];
const cells = [
  "1",
  "11/01/2026",
  "Self",
  "TEST",
  "Fixture Company",
  "Stock",
  "Purchase",
  "$1,001 - $15,000",
  "",
];
function ready() {
  return `<div id="content"><label>Annual<input name="report_type" type="checkbox" value="7"></label><label>Periodic Transactions<input name="report_type" type="checkbox" value="11"></label><input name="report_type" type="checkbox" value="10"><input name="report_type" type="checkbox" value="14"><input name="report_type" type="checkbox" value="15"><input name="filer_type" type="checkbox" value="1"><input name="filer_type" type="checkbox" value="4"><input name="filer_type" type="checkbox" value="5"><input id="fromDate"><input id="toDate"><button id="again" style="display:none" onclick="this.style.display='none'">Search Again</button><button onclick="start=0;query()">Search Reports</button><button id="filedReports_next" onclick="start+=2;query()">Next</button><script>let start=0;async function query(){let p=new URLSearchParams({start,length:2,report_types:JSON.stringify([...document.querySelectorAll('input[name=report_type]:checked')].map(e=>+e.value)),filer_types:JSON.stringify([...document.querySelectorAll('input[name=filer_type]:checked')].map(e=>+e.value)),submitted_start_date:document.querySelector('#fromDate').value+' 00:00:00',submitted_end_date:document.querySelector('#toDate').value+' 23:59:59'});await fetch('/search/report/data/',{method:'POST',body:p}).then(r=>r.json());document.querySelector('#again').style.display='inline';}</script></div>`;
}
(async () => {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const png = await sharp({
    create: { width: 500, height: 200, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const tiff = await sharp(png).tiff().toBuffer();
  const pdfDoc = await PDFDocument.create(),
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  pdfDoc
    .addPage([500, 300])
    .drawText("FIXTURE ONLY Annual Financial Disclosure", {
      x: 20,
      y: 250,
      size: 18,
      font,
    });
  const pdf = Buffer.from(await pdfDoc.save());
  const results = [];
  for (const mode of [
    "mixed",
    "intermediate",
    "background",
    "redirect-pdf",
    "empty",
    "overflow",
    "changed-total",
    "changed-bookend",
    "duplicate",
    "duplicate-scan",
    "wrong-filters",
    "missing-page",
    "unsupported-media",
    "media-external",
    "denied",
    "challenge",
  ]) {
    let acknowledgements = 0,
      indexes = 0,
      media = 0;
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const b of req) body += b;
      res.setHeader("content-type", "text/html");
      if (req.url === "/search/home/" && req.method === "GET")
        res.end(
          '<form method="POST"><input id="agree_statement" type="checkbox" onclick="this.form.submit()"></form><p>news and communications media; credit rating; solicitation of money</p><script>window.jQuery=f=>f()</script>' +
            (mode === "background"
              ? "<script>fetch('/background').then(r=>r.text())</script>"
              : ""),
        );
      else if (req.url === "/search/home/") {
        acknowledgements++;
        if (mode === "intermediate")
          res.end(
            '<form name="sec_sbsd_chlge_form"></form><div id="sec-if-cpt-container"></div><script>setTimeout(()=>location.href="/ready",100)</script>',
          );
        else if (mode === "challenge")
          res.end(
            '<div id="sec-if-cpt-container"><button>Verify</button></div>',
          );
        else {
          res.writeHead(302, { location: "/ready", "content-length": "0" });
          res.end();
        }
      } else if (req.url === "/background") {
        res.setHeader("content-type", "text/plain");
        res.write("held open");
      } else if (req.url === "/ready") res.end(ready());
      else if (req.url === "/search/report/data/") {
        indexes++;
        if (mode === "denied") {
          res.writeHead(403);
          res.end("Access Denied");
          return;
        }
        const p = new URLSearchParams(body),
          start = +p.get("start");
        let rows = mode === "empty" ? [] : structuredClone(data);
        if (mode === "duplicate") rows[1][3] = rows[0][3];
        if (mode === "changed-bookend" && indexes > 2)
          rows[0][3] = rows[0][3].replace(
            "Periodic Transaction Report",
            "Changed Amendment",
          );
        let total = rows.length;
        if (mode === "changed-total" && start > 0) total++;
        // request fields are checked independently by the collector; change via a redirect fixture below.
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            result: "ok",
            recordsTotal: total,
            recordsFiltered: total,
            data: rows.slice(start, start + 2),
          }),
        );
      } else if (req.url === paths[0])
        res.end(
          '<div id="content"><h1>Periodic Transaction Report</h1><h2>Fixture Senator</h2><table><thead><tr>' +
            headers.map((h) => "<th>" + h + "</th>").join("") +
            "</tr></thead><tbody><tr>" +
            cells.map((c) => "<td>" + c + "</td>").join("") +
            "</tr></tbody></table></div>",
        );
      else if (req.url === paths[1])
        res.end(
          '<div id="content"><h1>Annual Financial Disclosure</h1><h2>Fixture Senator</h2><a href="' +
            (mode === "media-external"
              ? "http://169.254.169.254/report.pdf"
              : "/media/report.pdf") +
            '">Download report</a><p>Annual holdings and income. FIXTURE ONLY.</p></div>',
        );
      else if (req.url === paths[2])
        res.end(
          '<div id="content"><h1>Paper Report Amendment</h1><img class="filingImage" src="/media/page1.png"><img class="filingImage" src="' +
            (mode === "duplicate-scan"
              ? "/media/page1.png"
              : "/media/page2.tif") +
            '"></div>',
        );
      else if (req.url === "/media/report.pdf") {
        media++;
        if (mode === "redirect-pdf") {
          res.writeHead(302, {
            location: "/media/final.pdf",
            "content-length": "0",
          });
          res.end();
        } else if (mode === "unsupported-media") {
          res.setHeader("content-type", "text/html");
          res.end("<h1>Access Denied</h1>");
        } else {
          res.setHeader("content-type", "application/pdf");
          res.end(pdf);
        }
      } else if (req.url === "/media/final.pdf") {
        media++;
        res.setHeader("content-type", "application/pdf");
        res.end(pdf);
      } else if (req.url === "/media/page1.png") {
        media++;
        res.setHeader("content-type", "image/png");
        res.end(png);
      } else if (req.url === "/media/page2.tif") {
        media++;
        res.setHeader("content-type", "image/tiff");
        if (mode === "missing-page") {
          res.statusCode = 404;
          res.end();
        } else res.end(tiff);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = "http://127.0.0.1:" + server.address().port;
    // Wrong-query case injects an unrelated filter through the actual browser's posted form.
    if (mode === "wrong-filters") {
      const original = server.listeners("request")[0];
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        if (req.url === "/ready") {
          res.setHeader("content-type", "text/html");
          res.end(
            ready().replace(
              "let start=0;",
              "let start=0;document.querySelector('input[name=report_type]').remove();",
            ),
          );
        } else original(req, res);
      });
    }
    let result;
    try {
      result = await run(path.join(root, mode), origin, {
        ...options,
        maxReports: mode === "overflow" ? 2 : 20,
      });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    assert.equal(acknowledgements, 1);
    assert(result.profile_removed);
    assert(result.all_requests_accounted, mode);
    if (
      ["mixed", "intermediate", "background", "redirect-pdf", "empty"].includes(
        mode,
      )
    ) {
      assert.equal(
        result.complete,
        true,
        JSON.stringify({
          mode,
          reason: result.reason,
          failures: result.report_failures,
        }),
      );
      assert.equal(result.index_scans.length, 2);
      assert.equal(result.reports.length, mode === "empty" ? 0 : 3);
      if (mode === "mixed" || mode === "redirect-pdf") {
        assert.equal(result.assets.length, 3);
        assert.equal(result.index_passes.length, 4);
        assert.equal(result.reports[0].transactions, 1);
      }
    } else {
      if (mode === "wrong-filters") {
        // Removing a visible filter changes the query scope: the known baseline controls must still exist.
        assert.equal(
          result.complete,
          false,
          "missing all-type control must not qualify",
        );
      } else assert.equal(result.complete, false, mode);
    }
    if (mode === "challenge") assert.equal(indexes, 0);
    results.push({
      mode,
      passed: true,
      complete: result.complete,
      reason: result.reason || null,
      indexes,
      media,
      source_requests: 0,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  await fs.writeFile(
    path.join(root, "FIXTURES_PASSED.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
