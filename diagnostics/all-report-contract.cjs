// Independently written all-report wire contract. No networking or persistence.
const crypto = require("node:crypto");
const { createRequire } = require("node:module"),
  path = require("node:path");
const upstream = createRequire(
  path.join(
    process.env.SENATE_UPSTREAM_ROOT || path.join(__dirname, ".."),
    "package.json",
  ),
);
const { load } = upstream("cheerio");
const ORIGIN = "https://efdsearch.senate.gov";
const MEDIA = "https://efd-media-public.senate.gov";
function requireThat(ok, reason) {
  if (!ok) throw Object.assign(new Error(reason), { sourceReason: reason });
}
function isoDate(value) {
  requireThat(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value,
    "valid_date_required",
  );
  return value;
}
function windowOptions(options) {
  const lower = isoDate(options.lower),
    upper = isoDate(options.upper);
  requireThat(
    lower <= upper && (Date.parse(upper) - Date.parse(lower)) / 86400000 < 31,
    "bounded_31_day_window_required",
  );
  const maxReports = options.maxReports ?? 100,
    maxAssets = options.maxAssets ?? 200;
  requireThat(
    Number.isInteger(maxReports) && maxReports > 0 && maxReports <= 1000,
    "invalid_report_bound",
  );
  requireThat(
    Number.isInteger(maxAssets) && maxAssets > 0 && maxAssets <= 1000,
    "invalid_asset_bound",
  );
  return { lower, upper, maxReports, maxAssets };
}
function reportRow(row, lower, upper, origin = ORIGIN) {
  requireThat(
    Array.isArray(row) &&
      row.length === 5 &&
      row.every((x) => typeof x === "string"),
    "invalid_index_row",
  );
  const $ = load(row[3]),
    links = $("a[href]");
  requireThat(links.length === 1, "one_report_link_required");
  const url = new URL(links.attr("href"), origin),
    match =
      /^\/search\/view\/([a-z][a-z0-9_-]{0,31})\/([0-9a-f-]{36})\/$/i.exec(
        url.pathname,
      );
  requireThat(
    url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      match,
    "untrusted_report_link",
  );
  requireThat(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      match[2],
    ),
    "invalid_report_uuid",
  );
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row[4]);
  requireThat(dateMatch, "invalid_filing_date");
  const filed = isoDate(`${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}`);
  requireThat(filed >= lower && filed <= upper, "filing_outside_window");
  return {
    id: match[2].toLowerCase(),
    kind: match[1].toLowerCase(),
    url: url.href,
    title: links.text().trim(),
    filing_date: filed,
    source_row: row,
  };
}
function indexPage(payload, request, selected, options, origin = ORIGIN) {
  const count = payload.recordsFiltered,
    start = Number(request.get("start")),
    length = Number(request.get("length"));
  requireThat(
    Number.isSafeInteger(count) &&
      count >= 0 &&
      count <= options.maxReports &&
      Array.isArray(payload.data) &&
      Number.isInteger(start) &&
      start >= 0 &&
      Number.isInteger(length) &&
      length > 0 &&
      length <= 100,
    "bounded_index_required",
  );
  requireThat(
    payload.result === undefined || payload.result === "ok",
    "index_result_not_ok",
  );
  for (const [key, values] of Object.entries(selected)) {
    let actual;
    try {
      actual = JSON.parse(request.get(key));
    } catch {
      requireThat(false, "query_filter_changed");
    }
    requireThat(
      Array.isArray(actual) &&
        actual.every(Number.isInteger) &&
        JSON.stringify([...actual].sort((a, b) => a - b)) ===
          JSON.stringify([...values].sort((a, b) => a - b)),
      "query_filter_changed",
    );
  }
  const slash = (d) =>
    d.slice(5, 7) + "/" + d.slice(8, 10) + "/" + d.slice(0, 4);
  requireThat(
    request.get("submitted_start_date") ===
      slash(options.lower) + " 00:00:00" &&
      request.get("submitted_end_date") ===
        slash(options.upper) + " 23:59:59" &&
      [
        "first_name",
        "last_name",
        "candidate_state",
        "senator_state",
        "office_id",
        "search[value]",
      ].every((k) => !request.get(k)),
    "query_scope_changed",
  );
  requireThat(
    payload.data.length === Math.min(length, Math.max(0, count - start)),
    "incomplete_index_page",
  );
  return {
    start,
    length,
    total: count,
    reports: payload.data.map((r) =>
      reportRow(r, options.lower, options.upper, origin),
    ),
  };
}
function scanComplete(pages) {
  requireThat(pages.length > 0, "index_scan_missing");
  let offset = 0;
  const reports = [],
    ids = new Set(),
    total = pages[0].total;
  for (const page of pages) {
    requireThat(
      page.start === offset && page.total === total,
      "index_scan_gap_or_total_change",
    );
    for (const report of page.reports) {
      requireThat(!ids.has(report.id), "duplicate_report_uuid");
      ids.add(report.id);
      reports.push(report);
    }
    offset += page.reports.length;
  }
  requireThat(offset === total, "index_scan_not_exhausted");
  return reports;
}
function sameBookends(first, second) {
  const sorted = (x) =>
    x
      .map((r) => r.source_row)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  requireThat(
    JSON.stringify(sorted(first)) === JSON.stringify(sorted(second)),
    "source_index_bookend_changed",
  );
}
function mediaUrl(value, base, origin = ORIGIN) {
  const u = new URL(value, base);
  requireThat(
    (u.origin === origin || u.origin === MEDIA) &&
      !u.username &&
      !u.password &&
      !u.hash &&
      u.href.length < 4096,
    "untrusted_media_url",
  );
  return u.href;
}
function documentAssets(body, base, origin = ORIGIN) {
  const $ = load(body),
    result = [];
  const add = (value, role) => {
    if (!value) return;
    const url = mediaUrl(value, base, origin);
    if (role === "scan_page")
      requireThat(
        !result.some((x) => x.url === url),
        "duplicate_scan_page_url",
      );
    if (!result.some((x) => x.url === url))
      result.push({ url, role, order: result.length + 1 });
  };
  $("img.filingImage, #content img[src]").each((_, e) => {
    const value = $(e).attr("src"),
      filing = $(e).hasClass("filingImage");
    if (filing) requireThat(value && value.trim(), "scan_page_src_missing");
    if (filing || !new URL(value, base).pathname.startsWith("/static/"))
      add(value, filing ? "scan_page" : "document_image");
  });
  ($("#content").length ? $("#content") : $("body"))
    .find("object[data],embed[src],iframe[src]")
    .each((_, e) => {
      const u = $(e).attr("data") || $(e).attr("src"),
        type = $(e).attr("type") || "";
      if (/pdf/i.test(type) || /\.pdf(?:[?#]|$)/i.test(u || "")) add(u, "pdf");
    });
  ($("#content").length ? $("#content") : $("body"))
    .find("a[href]")
    .each((_, e) => {
      const u = $(e).attr("href"),
        text = $(e).text();
      if (
        /\.(?:pdf|tiff?|png|gif|jpe?g)(?:[?#]|$)/i.test(u || "") ||
        /\b(?:attachment|download (?:report|filing)|view (?:pdf|original))\b/i.test(
          text,
        )
      )
        add(u, /\.pdf(?:[?#]|$)/i.test(u || "") ? "pdf" : "attachment");
    });
  $("script").each((_, e) => {
    const text = $(e).html() || "";
    for (const m of text.matchAll(/PDFObject\.embed\(\s*["']([^"']+)["']/g))
      add(m[1], "pdf");
  });
  return result;
}
function bytesKind(raw, contentType = "") {
  if (raw.subarray(0, 5).toString() === "%PDF-") return "pdf";
  if (raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image";
  if (raw[0] === 255 && raw[1] === 216) return "image";
  if (/^GIF8[79]a/.test(raw.subarray(0, 6).toString())) return "image";
  if (
    raw.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
    raw.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))
  )
    return "image";
  if (/^text\/html\b/i.test(contentType)) return "html";
  return "unsupported";
}
function fingerprint(report) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(report.source_row))
    .digest("hex");
}
module.exports = {
  ORIGIN,
  MEDIA,
  requireThat,
  windowOptions,
  reportRow,
  indexPage,
  scanComplete,
  sameBookends,
  mediaUrl,
  documentAssets,
  bytesKind,
  fingerprint,
};
