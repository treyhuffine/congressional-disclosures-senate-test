// Offline-source extraction: no Senate requests, no database or source activation.
// Upstream supplies Mistral OCR, orientation/coverage checks and independent PTR consensus.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { execFile } = require("node:child_process"),
  { promisify } = require("node:util");
const { createRequire } = require("node:module");
const upstream = createRequire(
  path.join(
    process.env.SENATE_UPSTREAM_ROOT || path.join(__dirname, ".."),
    "package.json",
  ),
);
const execute = promisify(execFile),
  sharp = upstream("sharp"),
  { load } = upstream("cheerio");
const source = upstream(
  "./packages/congressional-disclosures/dist/sources/senate.js",
);
const extraction = upstream(
  "./packages/congressional-disclosures/dist/extraction/index.js",
);
const poppler = upstream(
  "./packages/congressional-disclosures/dist/runtime/poppler.js",
);
const { LocalCache } = upstream(
  "./packages/congressional-disclosures/dist/runtime/cache.js",
);
const { MistralOcrClient } = upstream(
  "./packages/congressional-disclosures/dist/providers/mistralOcr.js",
);
const { OpenAiCompatibleCompletionClient } = upstream(
  "./packages/congressional-disclosures/dist/providers/openaiCompatible.js",
);
const { requireThat, bytesKind } = require("./all-report-contract.cjs");
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
async function original(capture, receipt) {
  requireThat(/^[0-9a-f]{64}$/.test(receipt.sha256), "original_hash_required");
  const p = path.join(capture, "objects", receipt.sha256),
    s = await fs.lstat(p);
  requireThat(
    s.isFile() && !s.isSymbolicLink() && s.size <= 64 * 1024 ** 2,
    "ordinary_bounded_original_required",
  );
  const raw = await fs.readFile(p);
  requireThat(
    hash(raw) === receipt.sha256 && raw.length === receipt.bytes,
    "original_checksum_differs",
  );
  return raw;
}
async function command(executable, args) {
  return execute(executable, args, {
    timeout: 60000,
    maxBuffer: 32 * 1024 ** 2,
    killSignal: "SIGKILL",
  });
}
async function pdfPages(raw, scratch, maxPages) {
  const input = path.join(scratch, "input.pdf");
  await fs.writeFile(input, raw, { mode: 0o600 });
  const info = (await command("pdfinfo", [input])).stdout,
    count = Number(/^Pages:\s*(\d+)/m.exec(info)?.[1]);
  requireThat(
    Number.isInteger(count) && count > 0 && count <= maxPages,
    "pdf_page_bound",
  );
  // Poppler handles empty-password encrypted PDFs directly; never copy encrypted pages through pdf-lib.
  await command("pdftoppm", [
    "-f",
    "1",
    "-l",
    String(count),
    "-r",
    "150",
    "-png",
    input,
    path.join(scratch, "page"),
  ]);
  const names = (await fs.readdir(scratch))
    .filter((x) => /^page-\d+\.png$/.test(x))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  requireThat(names.length === count, "all_pdf_pages_required");
  return Promise.all(names.map((n) => fs.readFile(path.join(scratch, n))));
}
async function imagePages(raw, maxPages) {
  const metadata = await sharp(raw, { limitInputPixels: 50e6 }).metadata(),
    pages = metadata.pages || 1;
  requireThat(pages <= maxPages, "image_page_bound");
  const result = [];
  for (let page = 0; page < pages; page++)
    result.push(
      await sharp(raw, { page, pages: 1, limitInputPixels: 50e6 })
        .png()
        .toBuffer(),
    );
  return result;
}
async function fixedWords(image) {
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "senate-ocr-orientation-"),
  );
  try {
    const file = path.join(scratch, "page.png");
    await fs.writeFile(file, image, { mode: 0o600 });
    // Fix segmentation so Tesseract cannot auto-rotate each candidate and erase orientation evidence.
    const tsv = (
      await command("tesseract", [file, "stdout", "--psm", "6", "tsv"])
    ).stdout;
    return tsv
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line) => {
        const cells = line.split("\t"),
          text = (cells[11] || "").trim(),
          confidence = Number(cells[10]);
        return text && Number.isFinite(confidence)
          ? [{ text, confidence }]
          : [];
      });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
async function upright(image, completion, model) {
  return extraction.uprightPage(image, {
    rotate: poppler.rotateImage,
    readWords: fixedWords,
    askUpright: async (candidates) => {
      if (!completion) return null;
      const body = {
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: 'Return JSON {"rotation":0|90|180|270} for the upright text orientation. Each image is labeled by clockwise rotation.',
              },
              ...candidates.flatMap((c) => [
                { type: "text", text: "rotation " + c.rotation },
                {
                  type: "image_url",
                  image_url: {
                    url: "data:image/png;base64," + c.image.toString("base64"),
                  },
                },
              ]),
            ],
          },
        ],
        response_format: { type: "json_object" },
      };
      const votes = [];
      for (let i = 0; i < 2; i++) {
        const { payload } = await completion.complete({
          model,
          body,
          timeoutMs: 120000,
        });
        try {
          votes.push(JSON.parse(extraction.responseText(payload)).rotation);
        } catch {
          votes.push(null);
        }
      }
      return votes[0] === votes[1] && [0, 90, 180, 270].includes(votes[0])
        ? votes[0]
        : null;
    },
  });
}
async function localRead(image, scratch, index) {
  const u = await upright(image),
    file = path.join(scratch, "ocr-" + index + ".png");
  await fs.writeFile(file, u.image, { mode: 0o600 });
  const markdown = (
    await command("tesseract", [file, "stdout", "-l", "eng", "--psm", "6"])
  ).stdout.trim();
  return {
    markdown,
    rotation: u.rotation,
    scores: u.scores,
    decidedBy: u.decidedBy,
    payload: {},
    engine: "tesseract",
    review_required: !markdown,
  };
}
function modelRunner(completion, model) {
  return async (requests, read) =>
    Promise.all(
      requests.map(async (attachments) => {
        const result = await extraction.extractPtrBatch(completion, {
          model,
          contract: "lake",
          form: "senate_paper",
          documents: attachments,
          idempotencyKey:
            "senate-held:" +
            extraction.ptrBatchIdempotencyKey(
              model,
              "lake",
              attachments,
              "senate_paper",
            ) +
            ":" +
            read.pass +
            ":" +
            Number(read.gap),
          timeoutMs: 120000,
        });
        const truncated = result.rawResponse?.choices?.some((x) =>
          ["length", "max_tokens"].includes(x.finish_reason),
        );
        return {
          attachments,
          result,
          ...(truncated ? { truncated: true } : {}),
        };
      }),
    );
}
async function processCapture(capture, output, settings = {}, injected = {}) {
  const manifestBody = await fs.readFile(path.join(capture, "manifest.json")),
    m = JSON.parse(manifestBody);
  requireThat(
    m.producer === "senate-all-reports-browser-v2" &&
      m.complete === true &&
      m.stage === "complete" &&
      (m.fixture_only === false ||
        (settings.fixtureOnly === true && m.fixture_only === true)),
    "verified_complete_capture_required",
  );
  requireThat(
    !settings.paid || settings.approveProviderCalls === true,
    "explicit_paid_provider_opt_in_required",
  );
  const maxPages = settings.maxPages ?? 40,
    maxCalls = settings.maxProviderCalls ?? 80;
  requireThat(
    Number.isInteger(maxPages) &&
      maxPages > 0 &&
      maxPages <= 200 &&
      Number.isInteger(maxCalls) &&
      maxCalls > 0 &&
      maxCalls <= 500,
    "extraction_bounds_required",
  );
  const usage = {
    provider_calls: 0,
    ocr_reads: 0,
    completion_reads: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
  };
  const ids = new Set();
  for (const r of m.reports) {
    requireThat(
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(r.id) &&
        !ids.has(r.id),
      "unique_report_uuid_required",
    );
    ids.add(r.id);
  }
  const previousFetch = global.fetch;
  const cache = new LocalCache(path.join(output, "private-cache"));
  const model = settings.model || "google/gemini-3.1-flash-lite";
  let ocr = injected.ocr,
    completion = injected.completion;
  if (settings.paid) {
    if (!ocr)
      requireThat(settings.ocrKey, "ocr_adapter_or_credentials_required");
    ocr ||= new MistralOcrClient({
      apiKey: settings.ocrKey,
      model: settings.ocrModel || "mistral-ocr-4-1",
      cache,
    });
    if (!completion && settings.completionKey)
      completion = new OpenAiCompatibleCompletionClient({
        apiKey: settings.completionKey,
        cache,
      });
  }
  await fs.mkdir(output, { mode: 0o700 });
  global.fetch = async (input, init) => {
    requireThat(settings.paid === true, "network_forbidden_in_free_extraction");
    const url = new URL(String(input));
    requireThat(
      ((url.protocol === "https:" &&
        [
          "https://api.mistral.ai",
          "https://openrouter.ai",
          ...(injected.networkOrigins || []),
        ].includes(url.origin)) ||
        (settings.fixtureOnly === true &&
          m.fixture_only === true &&
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1")) &&
        !url.username &&
        !url.password,
      "extraction_provider_origin_forbidden",
    );
    requireThat(usage.provider_calls < maxCalls, "provider_call_bound");
    usage.provider_calls++;
    return previousFetch(input, init);
  };
  const limitedCompletion = completion && {
    complete: async (request) => {
      requireThat(usage.completion_reads < maxCalls, "model_read_bound");
      usage.completion_reads++;
      const result = await completion.complete({
        ...request,
        body: { ...request.body, max_tokens: 8192 },
      });
      usage.prompt_tokens += result.usage.promptTokens;
      usage.completion_tokens += result.usage.completionTokens;
      return result;
    },
  };
  const results = [];
  try {
    for (const report of m.reports) {
      const item = {
        id: report.id,
        kind: report.kind,
        title: report.title,
        source_row: report.source_row,
        originals: [],
        pages: [],
        structured_status: "not_applicable",
        capture_manifest_sha256: hash(manifestBody),
      };
      results.push(item);
      const scratch = await fs.mkdtemp(
        path.join(os.tmpdir(), "senate-held-extraction-"),
      );
      try {
        const html = await original(capture, report.receipt);
        item.originals.push(report.receipt.sha256);
        const $ = load(html.toString());
        $("script,style,noscript,nav,footer").remove();
        item.document_text = (
          $("#content").length ? $("#content").text() : $("body").text()
        )
          .replace(/\s+/g, " ")
          .trim();
        const pages = [];
        for (const [index, asset] of report.assets.entries()) {
          const raw = await original(capture, asset.receipt);
          item.originals.push(asset.receipt.sha256);
          const kind = bytesKind(raw, asset.receipt.content_type);
          requireThat(
            ["pdf", "image"].includes(kind),
            "original_media_format_unsupported",
          );
          const directory = path.join(scratch, "asset-" + index);
          await fs.mkdir(directory);
          const rendered =
            kind === "pdf"
              ? await pdfPages(raw, directory, maxPages - pages.length)
              : await imagePages(raw, maxPages - pages.length);
          for (let i = 0; i < rendered.length; i++)
            pages.push({
              image: rendered[i],
              source_sha256: asset.receipt.sha256,
              source_page: i + 1,
            });
        }
        requireThat(pages.length <= maxPages, "filing_page_bound");
        const isPtr =
          report.kind === "ptr" || /periodic\s+transaction/i.test(report.title);
        if (report.kind === "ptr") {
          try {
            item.transactions = source.parseSenateElectronicPtr(
              html.toString(),
            );
            item.structured_status = "electronic_table";
          } catch {
            item.structured_status = "needs_review";
          }
        }
        if (settings.paid && limitedCompletion && isPtr && pages.length) {
          const readPage = async (image, label) => {
            const u = await upright(image, limitedCompletion, model);
            usage.ocr_reads += 2;
            requireThat(usage.ocr_reads <= maxCalls, "ocr_read_bound");
            const first = await ocr.readImage(u.image, label + " read1"),
              second = await ocr.readImage(u.image, label + " read2");
            const shortfall = extraction.ocrPageShortfall(
              first.markdown,
              u.scores,
              u.rotation,
            );
            const disagreement = extraction.ocrReadsDisagreement(
              first.markdown,
              second.markdown,
            );
            requireThat(
              !shortfall && !disagreement,
              "ocr_coverage_or_consensus_failed",
            );
            return {
              ...u,
              markdown: first.markdown,
              payload: first.payload,
              checkPayload: second.payload,
            };
          };
          const run = await extraction.extractSenatePaperReports(
            [
              {
                reportId: report.id,
                pages: pages.map((p) => p.image),
                filedOn: report.filing_date,
              },
            ],
            {
              ocrPage: readPage,
              uprightPageImage: (image, rotation) =>
                rotation === 0 ? image : poppler.rotateImage(image, rotation),
              run: modelRunner(limitedCompletion, model),
            },
            extraction.DEFAULT_HOUSE_EXTRACTION_BUDGETS.ocrText,
            2,
            1,
          );
          const extracted = run.extractions[0];
          item.consensus = run.consensus;
          item.structured_result = extracted.result;
          item.structured_status =
            extracted.result.error ||
            extracted.result.invalidRowIndexes.length ||
            extracted.result.reviewRowIndexes.length ||
            (!extracted.result.rows.length &&
              !extracted.result.noTransactionsStatement)
              ? "needs_review"
              : "consensus_proposal";
          item.pages = (extracted.ocrPages || []).map((p, i) => ({
            source_sha256: pages[i].source_sha256,
            source_page: pages[i].source_page,
            text: p.markdown,
            rotation: p.rotation,
            engine: "mistral",
            review_required: false,
          }));
        } else {
          for (let i = 0; i < pages.length; i++) {
            let read;
            try {
              if (settings.paid) {
                const u = await upright(
                  pages[i].image,
                  limitedCompletion,
                  model,
                );
                usage.ocr_reads++;
                requireThat(usage.ocr_reads <= maxCalls, "ocr_read_bound");
                const page = await ocr.readImage(
                  u.image,
                  report.id + " page " + (i + 1),
                );
                read = {
                  ...u,
                  markdown: page.markdown,
                  engine: "mistral",
                  review_required: !page.markdown.trim(),
                };
              } else
                read = await (injected.readLocalPage || localRead)(
                  pages[i].image,
                  scratch,
                  i,
                );
            } catch {
              read = {
                markdown: "",
                rotation: null,
                engine: "tesseract",
                review_required: true,
              };
            }
            requireThat(
              typeof read.markdown === "string" &&
                typeof read.engine === "string" &&
                read.engine.length < 80,
              "local_ocr_adapter_contract",
            );
            item.pages.push({
              source_sha256: pages[i].source_sha256,
              source_page: pages[i].source_page,
              text: read.markdown,
              rotation: read.rotation,
              engine: read.engine,
              review_required: read.review_required !== false,
            });
          }
          if (isPtr && report.kind !== "ptr")
            item.structured_status = "needs_model_extraction";
        }
        if (isPtr && item.transactions?.length && pages.length) {
          item.structured_status = "needs_review";
          item.review_reason = "html_table_with_additional_source_pages";
        }
        if (
          item.structured_status === "electronic_table" &&
          !item.transactions.length &&
          !/no transactions|nothing to report/i.test(item.document_text)
        )
          item.structured_status = "needs_review";
        item.text_status =
          item.pages.some((p) => p.review_required) ||
          item.pages.length !== pages.length
            ? "needs_review"
            : "text_extracted";
        item.text_engine_verified = false; // OCR output remains fallible even when all physical pages account.
      } catch (error) {
        item.text_status = "needs_review";
        item.error_code = error.sourceReason || "document_extraction_failed";
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
      await fs.writeFile(
        path.join(output, report.id + ".json"),
        JSON.stringify(item, null, 2) + "\n",
        { mode: 0o600 },
      );
    }
  } finally {
    global.fetch = previousFetch;
  }
  const result = {
    producer: "senate-held-extraction-v1",
    capture_manifest_sha256: hash(manifestBody),
    fixture_only: m.fixture_only,
    reports: results,
    usage,
    all_documents_accounted: results.length === m.reports.length,
    review_required: results.some(
      (r) =>
        r.text_status !== "text_extracted" ||
        ["needs_review", "needs_model_extraction"].includes(
          r.structured_status,
        ),
    ),
    database_access: false,
    source_requests: 0,
    source_activation: false,
  };
  await fs.writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  return result;
}
module.exports = {
  processCapture,
  original,
  pdfPages,
  imagePages,
  localRead,
  modelRunner,
};
if (require.main === module) {
  const [capture, output, ...flags] = process.argv.slice(2),
    paid = flags.includes("--allow-network") || flags.includes("--paid");
  const adapterIndex = flags.indexOf("--adapter");
  const adapter =
    adapterIndex >= 0 ? require(path.resolve(flags[adapterIndex + 1])) : null;
  Promise.resolve(
    adapter
      ? adapter({
          cacheRoot: path.join(output, "private-cache"),
          maxPages: 40,
          maxProviderCalls: 80,
        })
      : {},
  )
    .then((injected) =>
      processCapture(
        capture,
        output,
        {
          paid,
          approveProviderCalls: paid,
          ocrKey: paid ? process.env.MISTRAL_API_KEY : undefined,
          completionKey: paid ? process.env.OPENROUTER_API_KEY : undefined,
          model: process.env.SENATE_EXTRACTION_MODEL,
          maxPages: 40,
          maxProviderCalls: 80,
        },
        injected,
      ),
    )
    .then((r) =>
      console.log(
        JSON.stringify({
          reports: r.reports.length,
          review_required: r.review_required,
          usage: r.usage,
          source_requests: 0,
        }),
      ),
    )
    .catch((error) => {
      console.error(error.sourceReason || error.name);
      process.exitCode = 1;
    });
}
