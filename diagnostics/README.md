# One-shot Windows Senate diagnostic

This fork adds a manually dispatched Windows test of the unchanged Senate HTTP
client from upstream commit2965e8796bd4cb9423a83b964a1f9dbd076a0ad6.
The upstream project and license remain intact. This diagnostic does not claim
that Windows or Linux acquisition works until a live run demonstrates it.

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

Three actual Edge loopback fixtures gate the live attempt: normal empty302,
ordinary JavaScript transition through intermediate protection, and stopping at
an active challenge. The live attempt uses November4–5 PTRs, seven-second notice
dwell, one acknowledgement, five reports maximum, two matching exhausted index
passes and a225-second inner deadline. CDP observations reject cached or
service-worker index responses. Original HTTP HTML/JSON bodies, hashes and
clocks are retained; screenshots or rendered DOM are not capture substitutes.

This browser diagnostic is a new independent harness rather than a modification
of the upstream HTTP source client. It creates no production schedule and writes
no database. Each manual dispatch runs exactly one selected acquisition method.
