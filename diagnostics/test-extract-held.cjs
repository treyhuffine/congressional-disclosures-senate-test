// Real local OCR + unchanged upstream OCR/consensus against local fake provider HTTP endpoints.
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto"),
  sharp = require("sharp");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { processCapture, pdfPages, imagePages } = require("./extract-held.cjs");
const {
  MistralOcrClient,
} = require("../packages/congressional-disclosures/dist/providers/mistralOcr.js");
const {
  OpenAiCompatibleCompletionClient,
} = require("../packages/congressional-disclosures/dist/providers/openaiCompatible.js");
const root = process.argv[2],
  fixture = process.argv[3],
  hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
(async () => {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const capture = path.join(root, "capture");
  await fs.cp(fixture, capture, { recursive: true });
  const m = JSON.parse(await fs.readFile(path.join(capture, "manifest.json")));
  assert.equal(m.fixture_only, true);
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  const lines = [
    "FIXTURE ONLY - Periodic Transaction Report",
    "Fixture Senator",
    "Nothing to report",
    "I certify that no transactions require disclosure on this form.",
  ];
  for (let i = 0; i < lines.length; i++)
    page.drawText(lines[i], { x: 30, y: 740 - i * 45, size: 14, font });
  const raster = path.join(root, "raster");
  await fs.mkdir(raster);
  const png = (await pdfPages(Buffer.from(await pdf.save()), raster, 10))[0];
  const tiff = await sharp(png).tiff().toBuffer();
  const paper = m.reports.find((r) => r.kind === "paper");
  for (const [i, asset] of paper.assets.entries()) {
    const raw = i === 0 ? png : tiff,
      old = asset.receipt.sha256,
      sha = hash(raw);
    await fs.writeFile(path.join(capture, "objects", sha), raw);
    for (const r of m.receipts)
      if (r.sha256 === old) {
        r.sha256 = sha;
        r.bytes = raw.length;
      }
    for (const r of m.assets)
      if (r.receipt.sha256 === old) {
        r.receipt.sha256 = sha;
        r.receipt.bytes = raw.length;
      }
    asset.receipt.sha256 = sha;
    asset.receipt.bytes = raw.length;
  }
  await fs.writeFile(path.join(capture, "manifest.json"), JSON.stringify(m));
  const free = await processCapture(capture, path.join(root, "free"), {
    fixtureOnly: true,
    maxPages: 10,
  });
  const freePaper = free.reports.find((r) => r.kind === "paper");
  assert.equal(free.usage.provider_calls, 0);
  assert.equal(freePaper.pages.length, 2);
  assert(
    freePaper.pages.every((p) => /Fixture Senator/i.test(p.text)),
    JSON.stringify(freePaper),
  );
  assert.equal(freePaper.structured_status, "needs_model_extraction");
  assert.equal(
    free.reports.find((r) => r.kind === "ptr").structured_status,
    "electronic_table",
  );
  assert.equal(free.reports.find((r) => r.kind === "annual").pages.length, 1);
  const multi = await sharp({
    create: {
      width: 100,
      height: 200,
      pageHeight: 100,
      channels: 3,
      background: "white",
    },
  })
    .tiff()
    .toBuffer();
  assert.equal((await imagePages(multi, 10)).length, 2);
  await assert.rejects(imagePages(multi, 1), /image_page_bound/);
  let customReads = 0;
  const custom = await processCapture(
    capture,
    path.join(root, "custom-local"),
    { fixtureOnly: true, maxPages: 10 },
    {
      readLocalPage: async () => {
        customReads++;
        return {
          markdown: "CUSTOM OFFLINE FIXTURE",
          rotation: 0,
          engine: "custom-local-fixture",
          review_required: false,
        };
      },
    },
  );
  assert.equal(customReads, 3);
  assert.equal(custom.usage.provider_calls, 0);
  assert(
    custom.reports
      .flatMap((r) => r.pages)
      .every((p) => p.engine === "custom-local-fixture"),
  );
  let ocrCalls = 0,
    modelCalls = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    if (req.url === "/ocr") {
      ocrCalls++;
      assert.equal(value.document.type, "image_url");
      res.end(
        JSON.stringify({
          pages: [
            {
              markdown: lines.join("\n"),
              dimensions: { width: 1275, height: 1650 },
            },
          ],
        }),
      );
    } else {
      modelCalls++;
      const id =
        value.response_format?.json_schema?.schema?.properties?.documents?.items
          ?.properties?.source_id?.enum?.[0];
      if (!id && value.response_format?.type === "json_object") {
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{\"rotation\":0}' } }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
        );
        return;
      }
      assert(id, "upstream structured output must bind the original report ID");
      const response = {
        documents: [
          {
            source_id: id,
            no_transactions_statement: "Nothing to report",
            amended_report_date: null,
            amended_report_date_iso: null,
            non_transaction_rows: [1, 2, 3, 4, 5, 6, 7, 8],
            continuation_rows: [],
            rows: [],
          },
        ],
      };
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(response) },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 30,
            total_tokens: 130,
          },
        }),
      );
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  let paid;
  try {
    paid = await processCapture(
      capture,
      path.join(root, "paid-loopback"),
      {
        fixtureOnly: true,
        paid: true,
        approveProviderCalls: true,
        maxPages: 10,
        maxProviderCalls: 30,
      },
      {
        ocr: new MistralOcrClient({ apiKey: "FIXTURE_ONLY", baseUrl: base }),
        completion: new OpenAiCompatibleCompletionClient({
          apiKey: "FIXTURE_ONLY",
          baseUrl: base,
        }),
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  const parsed = paid.reports.find((r) => r.kind === "paper");
  assert.equal(
    parsed.structured_status,
    "consensus_proposal",
    JSON.stringify(parsed),
  );
  assert.equal(parsed.pages.length, 2);
  assert(ocrCalls >= 4);
  assert(modelCalls >= 2);
  assert.equal(paid.usage.provider_calls, ocrCalls + modelCalls);
  // The fake no-transactions answer is only a wire/consensus fixture, never source evidence.
  await assert.rejects(
    processCapture(capture, path.join(root, "not-opted-in"), {
      fixtureOnly: true,
      paid: true,
    }),
    /explicit_paid/,
  );
  const result = {
    fixture_only: true,
    source_requests: 0,
    paid_provider_requests: 0,
    real_local_ocr: true,
    free_pages: free.reports.reduce((n, r) => n + r.pages.length, 0),
    upstream_consensus_passed: true,
    loopback_ocr_calls: ocrCalls,
    loopback_model_calls: modelCalls,
  };
  await fs.writeFile(
    path.join(root, "FIXTURES_PASSED.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
