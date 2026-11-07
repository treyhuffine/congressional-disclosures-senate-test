# One-shot Senate acquisition diagnostic

This fork adds a manually dispatched Windows test of the unchanged Senate HTTP
client from upstream commit2965e8796bd4cb9423a83b964a1f9dbd076a0ad6.
The upstream project and license remain intact. The unchanged HTTP client returned
notice200 then acknowledgement403 on Windows and Linux. Fresh headed Windows Edge
subsequently completed two fully automated live captures; Linux browser acquisition
remains denied in the tested configurations. The exact protection rule is unknown.

The workflow builds under Node22.23.4 and runs four loopback protocol fixtures.
Only an explicit collect=true dispatch then permits one fresh notice
acknowledgement. There are no retries, schedules, imported browser sessions,
database writes, model calls or OCR calls.

The live query starts November4,2026 using the upstream client's blank end date.
Before fetching reports, the harness requires an exhausted index of at most five
rows, all within November4–6. It captures at most five reports and two matching
index passes. Request/body/time bounds prevent broad collection. It stops on
denial, interactive challenge or an unexpected redirect.

The harness only changes runtime limits, response recording and offline fixture
transport mapping. The source client's cookie and request recipe stays intact.
Its custom fetch wrapper is configured for zero retries. Known protection HTML
is stopped before it can be misread as a successful application response.

Original response bodies remain private: the workflow requires a one-time
32-byte base64 key in the SENATE_EVIDENCE_KEY Actions secret, and uploads only an
AES-256-GCM encrypted ZIP. Public logs contain safe result counts/statuses.
Cookie values and CSRF request values are never logged. Do not upload raw
response directories, HAR files, browser profiles or session bundles.

The repository owner must retain the decryption key privately until reviewing
the artifact. This diagnostic is not a production collection schedule.

## Headed Edge comparison

The method=browser option uses installed Edge with a fresh temporary profile,
its normal user agent and headers, sandboxing requested, and pinned
rebrowser-playwright-core1.64.102 / playwright-extra4.3.6. No stealth plugin or
identity override is applied. Ordinary site JavaScript loads normally; active
interactive challenges stop the run. No personal profile or session is imported.

Four actual Edge loopback fixtures gate the live attempt: normal empty302,
ordinary JavaScript transition through intermediate protection, a held-open background request, and stopping at
an active challenge. The live attempt uses November4–5 PTRs, seven-second notice
dwell, one acknowledgement, five reports maximum, two matching exhausted index
passes and a225-second inner deadline. CDP observations reject cached or
service-worker index responses. Original HTTP HTML/JSON bodies, hashes and
clocks are retained; screenshots or rendered DOM are not capture substitutes.

This browser diagnostic is a new independent harness rather than a modification
of the upstream HTTP source client. It creates no production schedule and writes
no database. Each manual dispatch runs exactly one selected acquisition method.

Loaded notice/jQuery readiness and a bounded dwell gate the acknowledgement.
Background traffic is observed for at most ten seconds, recorded, and allowed
to remain active; active challenges still stop the run.

The platform input also permits macos-15. That selects an installed Chrome
browser in a fresh profile, without changing its native identity. Each platform
must pass its own four browser fixtures. Public logs identify which platform
and browser were observed; OS-wide access is not inferred from one run.

## Reproduced cloud result and one-command caller

Two fresh GitHub-hosted Windows jobs using this exact worker commit succeeded:

- [First capture](https://github.com/treyhuffine/congressional-disclosures-senate-test/actions/runs/42338917021)
- [Fresh repeat](https://github.com/treyhuffine/congressional-disclosures-senate-test/actions/runs/42339495122)

Each captured the same November4 filing (four transactions) for the November4–5,2026
window: eight original HTTP receipts, one empty acknowledgement302, report HTML and
two independent network index JSON responses. Both bundles passed independent native
content/accounting checks and a persistence-forbidden dry-run in the consuming project.
This is one distinct filing observed twice, not a full-history or recurring-service test.

The tag `senate-browser-qualified-20261106` pins worker commit
`5d750416b27532107517570e6d0b1fae7d406637`. Installed Edge and the hosted image can
change; every run records observed versions and gates itself on real browser fixtures.
The macOS platform option is prepared but has not been live-tested here.

A Linux, Mac or Windows caller needs Python3.10+, Node22+ and authenticated GitHub CLI
with permission to dispatch this fork's workflow and manage its repository Actions
secret. No local browser, Windows desktop, copied cookies or PowerShell is required:

```sh
git clone --branch codex/windows-senate-trial https://github.com/treyhuffine/congressional-disclosures-senate-test.git
cd congressional-disclosures-senate-test
python3 diagnostics/test-run-trial.py
python3 diagnostics/run-trial.py --output ./private-fixture-run
```

That last command is **fixture-only**, with no Senate request. For one bounded live
capture of the fixed qualified window, use a new output path and explicit collection:

```sh
python3 diagnostics/run-trial.py --output ./private-live-run --collect
```

The caller verifies the qualified tag's commit, refuses another active diagnostic or
existing evidence key, creates a one-time key, dispatches, waits, downloads and
authenticates the encrypted artifact, and writes originals privately under
`private-evidence/source/capture`. Its `RESULT.json` records the worker/run and cleanup.
It removes the repository secret and local key after the job reaches terminal state.
A timeout cancels only its identified dispatch. If terminal state cannot be established,
it preserves the key outside evidence and records recovery/cleanup requirements;
resolve those before another run. Do not dispatch concurrent callers manually.

Use `--repo OWNER/FORK` only for a fork with this workflow and the same qualified tag.
There is no schedule, automatic denial retry, database import or source activation.
The dated window is deliberate: generalizing dates, larger pagination and unattended
integration belong in a separate reviewed change after this acquisition proof.
