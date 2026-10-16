# backlink file and script inventory

Paths and `<ref file>` pointers in the preserved XML below are relative to `backlink/SKILL.md`. Read this only when locating a data file, script, or reference.

<tree><![CDATA[
backlink/
├── SKILL.md              ← you are here: laws + routing + workflow entry points
├── CONTRIBUTING.md       ← how to submit a PR, the data model, the evidence rule
│
├── data/                 ← THE DATABASE. Machine-readable, PR-able, CI-checked.
│   ├── free-channels.json       places that publish a link at no cost
│   ├── submission-targets.json  routes that ACCEPT a submission — first-pass library
│   ├── paid-platforms.json      platforms observed carrying purchased placements
│   ├── network-fingerprints.json known automation/PBN families; negative evidence, never placements
│   ├── index-submission.json    engines that take a URL and publish NO link
│   └── schema/                  JSON Schema for the files above
│
├── scripts/              ← run these; do not re-derive their knowledge by hand
│   ├── validate-data.mjs           PR gate. CI runs exactly this. Must exit 0.
│   ├── validate-skill-xml.mjs      the OTHER gate: SKILL.md body well-formed + every
│   │                               <ref>/<law-ref> resolves. A bare <tag> in prose
│   │                               silently unbalances the doc from that line on.
│   ├── self-test.mjs               end-to-end smoke over the core scripts
│   ├── health.mjs                  run before ANY browser task
│   ├── opencli-core.mjs            ★ defaultSession(), batchBrowser(), openAndEval(), run(), closeSession()
│   ├── lib-automation-window.mjs   ★ virtual-display strategy for visibility-dependent reports
│   │                               (2026-09-14). launchTool({window:'virtual-display'}) holds the tool lock,
│   │                               detects a non-primary screen whose name matches /虚拟|Virtual/ (override:
│   │                               --automation-display <name|/re/|off>, or BACKLINK_AUTOMATION_DISPLAY in env /
│   │                               the Skill .env), keeps the session tab in an opencli `--window isolated`
│   │                               window, moves ONLY that window onto the screen (AppleScript set bounds —
│   │                               refused if the window holds any tab opencli does not know), `tab select`s
│   │                               it and reads visibilityState back before the caller navigates. Never
│   │                               activates Chrome, never `open -a` (source-guard test). A hidden read runs a
│   │                               bounded recovery (re-detect → move back → tab select). No screen ⇒
│   │                               mode:"fallback" and the caller's previous behaviour. Default for
│   │                               semrush-overview / semrush-traffic; opt-in (--window virtual-display) for
│   │                               semrush-report / semrush-keyword / tools-share-open. Output:
│   │                               automationWindow {mode, display,
│   │                               windowId, moves, tabSelects, recoveries, visibility, frontmostAppSamples}.
│   │                               Do not drag your own tabs into the automation window during a run: the
│   │                               extension then treats it as borrowed and the next isolated run opens a new
│   │                               window on the main screen. See references/authorized-data-sources.md
│   ├── lib-tools-share.mjs         ★ the ONE panel launcher
│   ├── tools-share-open.mjs        launch a tool by name; --goto for a deep link
│   ├── tools-share-node.mjs        `list` a tool's nodes (read-only) or `probe` them one by
│   │                               one — each node is a DIFFERENT shared account, so a node
│   │                               capped on its daily report quota is fixed by switching node,
│   │                               not by retrying
│   ├── similarweb-query.mjs        one domain's Similarweb report through the **official
│   │                               pro.similarweb.com same-origin JSON API** (2026-10-13 —
│   │                               the shared panel is retired for Similarweb). Reports:
│   │                               performance | channels | similar-sites | audience-geo |
│   │                               site-keywords | audience-interests | audience-overlap |
│   │                               audience-demographics. The window is pinned by the API
│   │                               itself (isWindow=true&latest=28d|6m), so the script does no
│   │                               date arithmetic and there is no rendered-window to mismatch
│   │                               — no scope-mismatch / ok-unverified / unconfirmed* /
│   │                               windowMatchesRequest, no scrolling, no visibilityState gate.
│   │                               site-keywords takes --traffic-tab organic|paid (no total: the
│   │                               API 400s on any SourceType but Organic|Paid). audience-overlap
│   │                               requires --compare <d1,d2[,d3]>; it refuses to guess the
│   │                               panel's default peers. --window defaults to background: a
│   │                               same-origin fetch needs no rendering. status is
│   │                               ok|no-data|unavailable
│   ├── similarweb-keywords.mjs     seed keyword → thousands of related keywords.
│   │                               The keyword-research entry point the pipeline was missing.
│   │                               Official pro.similarweb.com JSON API
│   │                               (/api/KeywordGenerator/google/suggest), no DOM scraping
│   ├── similarweb-batch.mjs        bulk traffic screen — one login, N domains, resumable;
│   │                               emits evidence rows (monthlyVisits+globalRank+stopReason
│   │                               + raw header JSON), no verdicts. Official
│   │                               pro.similarweb.com JSON API (/api/WebsiteOverview/getheader),
│   │                               so no rendered window to mismatch and no screenshot
│   ├── semrush-batch.mjs           same, on the other card's quota (organic traffic).
│   │                               Same domain-overview page as semrush-overview.mjs,
│   │                               so the same scope rule applies: no --db ⇒ global
│   │                               (scope:"global"), --db xx ⇒ that country. `confirmed`
│   │                               needs BOTH witnesses judgeScope() requires: the DOM
│   │                               region selector (SCOPE_PROBE_JS) AND an RPC witness
│   │                               (country-traffic rows + trend series, rpcScopeWitness())
│   │                               built per-domain from a CDP capture armed before each
│   │                               navigation + the in-page hook, merged via flattenRpc()
│   │                               — all reused as-is from lib-semrush-overview.mjs, never
│   │                               modified here. Rows that don't reach confirmed get
│   │                               stopReason:"scope-unconfirmed" (not in
│   │                               lib-batch-evidence.mjs's COMPLETE_STOP_REASONS, so it
│   │                               retries) and their numbers move to
│   │                               unconfirmedOrganicTraffic/unconfirmedAuthorityScore
│   │                               instead of the main fields. Only reads the top card, not
│   │                               the organic/ads research groups' own country badges, so
│   │                               every scopeEvidence carries sectionScopeNotApplicable:true.
│   │                               Each row also carries a trimmed rpcEvidence:[{id, kind,
│   │                               timestamp, msFromNavStart}] (2026-09-14, no response bodies)
│   │                               for multi-domain audits — "was this witness data actually
│   │                               this domain's, or a stale cross-domain straggler"
│   ├── lib-batch-evidence.mjs      the batch scripts' shared evidence contract — row shape,
│   │                               completeness (resume) semantics, evidence-dir paths
│   ├── semrush-overview.mjs        full-page domain overview, 23 sections (AI
│   │                               visibility, SEO 8-tile card, by-country,
│   │                               trend charts, organic/ads research,
│   │                               backlinks). No --db ⇒ global database;
│   │                               --db xx ⇒ that country — the page's own
│   │                               region selector is read back and cross-
│   │                               checked into scopeEvidence, and a mismatch
│   │                               or unreadable selector blocks completion.
│   │                               The organic/ads research groups carry their
│   │                               own country badge (account-level sticky
│   │                               country, not the page selector): every
│   │                               section reports its own scope, sectionScopes
│   │                               sums it up, --organic-db xx pins them (an
│   │                               account-state write, logged), unpinned or
│   │                               unconfirmed groups block completion, and so
│   │                               do rpc responses captured without a body.
│   │                               Two witnesses: /dpa/rpc
│   │                               JSON-RPC responses (structured data) +
│   │                               shadow-DOM token stream (proves what
│   │                               actually rendered). status: complete only
│   │                               when every section hits a terminal state
│   │                               AND the network gate passes in the same
│   │                               round; timeout ⇒ incomplete, never a
│   │                               look-alike success. See the
│   │                               「semrush-overview.mjs：整页抓取与完成
│   │                               判定」 subsection below. Window/visibility
│   │                               (2026-09-14): --window defaults to
│   │                               virtual-display (lib-automation-window.mjs:
│   │                               visible, activations 0); with no virtual
│   │                               screen it falls back to `active`
│   │                               (was `foreground`) — same tab-selected,
│   │                               non-OS-raising default as similarweb-query.mjs.
│   │                               --activate-chrome (default true, unchanged)
│   │                               now only gates OS-level `open -a` calls
│   │                               (before nav + on a hidden read), capped at
│   │                               --max-activations (default 3) for the whole
│   │                               run; past the cap it stops raising and just
│   │                               lets the existing hidden-tab gate report
│   │                               incomplete as before. false also downgrades
│   │                               an explicit --window foreground to active
│   │                               (foreground itself is an OS-level raise,
│   │                               so it can't be used to route around the
│   │                               false promise). Output carries
│   │                               readiness.visibilityActions: {windowMode,
│   │                               windowModeDowngraded, activations,
│   │                               activationLog:[{at,reason}],
│   │                               activationCapReached, hint, errors}
│   ├── lib-semrush-overview.mjs   ★ pure logic behind it — section specs,
│   │                               RPC response-shape classifier, DOM
│   │                               segmentation, completion gate, the
│   │                               runReadiness loop. No browser calls;
│   │                               offline-tested by
│   │                               tests/semrush-overview-readiness.test.mjs
│   ├── semrush-keyword.mjs         keyword detail plus one-session multi-country bulk plans.
│   │                               No worldwide selector on this page, so --db is no longer
│   │                               defaulted (was "jp"): single-keyword mode without --db
│   │                               reports volume as globalVolume (volumeScope:"global") and
│   │                               nulls kd/cpc/competition/results (countryMetricsAvailable:
│   │                               false) instead of silently mixing in whatever country the
│   │                               page happens to land on; bulk/--bulk-plan still require an
│   │                               explicit country
│   ├── semrush-report.mjs          the OTHER eight no-export reports (incl. referring-domains,
│   │                               --rollup aggregates the rows THIS run fetched); reuses one
│   │                               session; table reports paginate — pass --all-pages or it warns.
│   │                               organic-overview/organic-positions/organic-pages/keyword-magic/
│   │                               keyword-overview have no worldwide selector and land on an
│   │                               unpredictable country without --db (account-shared state,
│   │                               observed drifting us/jp/kr with nothing changed on our end) —
│   │                               these five now hard-fail with exit 2 if --db is omitted, and
│   │                               emit scope/scopeEvidence read back from the page's region
│   │                               selector. 2026-09-14 live-tested (8 page loads, CDP capture +
│   │                               a redacted custom hook): keyword-overview/keyword-magic fire
│   │                               NO /dpa/rpc or /kwogw traffic at all in DOM-polling mode;
│   │                               organic-overview/organic-positions/organic-pages DO call
│   │                               /dpa/rpc but never return a 'trend' kind, and their
│   │                               googleCountries table is identical regardless of --db — neither
│   │                               gives rpcScopeWitness()/trendContextFromText() anything usable.
│   │                               So judgeScope() still never gets an rpcWitness here and
│   │                               structurally can't say "confirmed"; a DOM-only-confirmed
│   │                               unverified result is relabeled verdict:"dom-only" (distinct
│   │                               from a real unverified/mismatch) instead of shipping a guessed
│   │                               RPC witness — see authorized-data-sources.md's "report.mjs 口径
│   │                               证据现状与实测结论" for the full per-report findings and the
│   │                               one open lead (an unexplored /mini-kwogw/v2/webapi request on
│   │                               organic-positions). backlinks-list/referring-domains/
│   │                               backlinks-overview are not country-scoped and unaffected.
│   │                               Also: paginated/virtualized tables now get an honest
│   │                               top-level status — assessCompleteness() turns a stopped-short
│   │                               pagination, a parser/raw-row mismatch, or a detected
│   │                               virtual-scroll truncation into status:"unverified" (exit 3)
│   │                               instead of only a console.error a JSON-only caller would miss.
│   │                               2026-09-14 round 4 (offline, no live retest): closed two
│   │                               "evidence missing ⇒ silently pass" gaps a live checker found
│   │                               — readPageInfo() used to default an unparseable pager to
│   │                               {current:1, total:1} (now unverifiable:true), and
│   │                               reportCoverage() used to default an unparseable headline
│   │                               total to "not truncated" (now totalUnverifiable:true for
│   │                               non-crossPageTotal reports). Both now block status:"complete"
│   │                               unless full pagination + consistent row counts independently
│   │                               prove capture is complete. Also distinguishes the everyday
│   │                               "ran without --all-pages on a big table (e.g. keyword-magic's
│   │                               283 pages)" case — status:"partial-by-design" (exit 0, not a
│   │                               defect) — from a genuine capture failure (status:"unverified",
│   │                               exit 3); every status carries pagesCaptured/pagesTotal
│   ├── semrush-traffic.mjs         Traffic & Market (.Trends) TOTAL visits — the only
│   │                               Semrush number comparable with Similarweb. Runs
│   │                               **visible by default** — virtual-display first
│   │                               (lib-automation-window.mjs), `--window foreground`
│   │                               only when no virtual screen is found:
│   │                               the summary never hydrates if it *loads* hidden.
│   │                               But "empty" has two unrelated causes with opposite
│   │                               remedies — not hydrated vs never had a table — and
│   │                               only the first is worth re-reading.
│   │                               See <law-ref id="hidden-tabs-do-not-hydrate"/>
│   ├── traffic-crosscheck.mjs      offline: eats one semrush-traffic.mjs JSON and one
│   │                               similarweb-query.mjs JSON and reports the DIFFERENCES
│   │                               between them — never an agree/diverge/conflict verdict,
│   │                               never a non-zero exit for a big diff. How to read a gap:
│   │                               references/traffic-screen.md. Never touches a page itself
│   ├── tools-share-evidence.mjs    rendered, redacted evidence bundle for one report.
│   │                               For a NEW capture prefer scripts/ground-truth.mjs (the
│   │                               two-witness collector); come here for the REPORTS route
│   │                               registry (which URL is which report) and for the wider
│   │                               artifact set (html / ax / network / app-json)
│   ├── page-read.mjs               render a public page → text, prices, paywall signal
│   │                               spans (matched text + context, never verdict booleans)
│   ├── apply-traffic-screen.mjs    write measured numbers + evidence paths back (never verdicts)
│   ├── inspect-page.mjs            full form census (every form, every field, semantics +
│   │                               markers) + scene evidence; fillable/blocker are marked
│   │                               `suggested` — the AI judges from the census + screenshot
│   ├── lib-form-scan.mjs          ★ the ONE census + marker-assignment expression, extracted
│   │                               out of inspect-page.mjs 2026-09-12 so submit-known.mjs
│   │                               (below) gets the exact same per-element census — same
│   │                               page, same markers — without a second copy of the DOM walk.
│   ├── safe-fill.mjs               fill a reviewed payload, never submit; refusal exits
│   │                               leave a captureScene pair first
│   ├── lib-evidence-scene.mjs     ★ captureScene(): the ONE failure-scene contract —
│   │                               piercing census + screenshot, paired, redacted, never
│   │                               throws. Every browser script's failure branch calls it
│   │                               BEFORE any close/exit (先取证后死、先取证后关).
│   │                               Reuses ground-truth.mjs's CENSUS_EXPR verbatim.
│   ├── lib-deep-dom.mjs           ★ the ONE shadow-DOM-piercing traversal. EVERY counting
│   │                               probe goes through it. Measured 2026-08-29 on one page,
│   │                               one instant: body.innerText 59 chars / deep text
│   │                               1,605,054 / 44 shadow roots. innerText and
│   │                               querySelectorAll both stop at the shadow boundary, so
│   │                               every table / cell / text count taken before this file
│   │                               existed measured a sliver of the page. Emits the LIGHT
│   │                               reading beside the deep one - the gap is the diagnostic.
│   │                               Also holds the segmented-scroll capability (default off)
│   │                               and readChartGeometry() - per-SVG text/mark PIXEL
│   │                               positions, the collection surface chart-only routes need
│   │                               (default OFF: one getBoundingClientRect per node forces
│   │                               layout; ground-truth opens it once AFTER chart readiness).
│   │                               See <law-ref id="readiness-must-bind-to-this-query"/>
│   ├── lib-chart-read.mjs         ★ the chart-only READER. Extracts axis ticks, axis range,
│   │                               x labels, series names from census.deepText, and per-point
│   │                               values from census.chartGeometry when present. It CONVERTS
│   │                               AND EXTRACTS, it does not conclude. Anything it cannot read
│   │                               is `value: null` + an `uncertain` reason code - never a
│   │                               plausible-looking guess, so "unreadable" and "the value is
│   │                               0" stay distinguishable. NOTE: `census.deep.svgText` is a
│   │                               COUNT, not text; without chartGeometry the reader tops out
│   │                               at `capability: 'axis-only'`.
│   ├── lib-report-readiness.mjs    ★ the report-route criteria, and the HARD GATE that runs
│   │                               BEFORE any classification: landed path == requested
│   │                               route, header domain == requested target, content region
│   │                               non-empty. Any one failing ⇒ `inconclusive`, never
│   │                               `no-table` and never `empty`.
│   ├── lib-submit-outcome.mjs      ★ the ONE "did this submission get accepted" criterion.
│   │                               Paired on purpose: acceptance evidence must sit OUTSIDE
│   │                               every form, and no rejection marker may be present — a
│   │                               form that silently redraws itself with our own URL echoed
│   │                               back into its input satisfies "our URL is on the page"
│   │                               while nothing was accepted.
│   │                               See <law-ref id="readiness-must-bind-to-this-query"/>
│   ├── release-submit-guard.mjs    only after explicit per-submission approval
│   ├── submit-directory.mjs        the single-target driver; one session per staged site
│   ├── adapter-phpld.mjs           ★ reference implementation of one-session-per-site
│   ├── adapter-phpld-submit.mjs    Lane A submit for that family. SEPARATE ON PURPOSE —
│   │                               staging is safe family-wide, pressing submit is not,
│   │                               and the two must never share a flag. Re-checks for a
│   │                               challenge that appeared since staging, and refuses.
│   ├── submit-known.mjs           ★ recipe-driven driver for a target that has ALREADY
│   │                               been fully walked once by hand — skips ONLY the AI
│   │                               field-mapping step (reads scripts/known-forms/<domain>.json),
│   │                               still re-scans the live page every run and still runs
│   │                               safe-fill.mjs's own live guard + release-submit-guard.mjs
│   │                               unmodified. See references/known-forms.md.
│   ├── known-forms/                one recipe JSON per already-verified domain (e.g.
│   │                               playlin.io.json, projectpedia.net.json) consumed by
│   │                               submit-known.mjs — see references/known-forms.md
│   ├── ledger.mjs                  candidate → … → indexed → rel_verified; stats +
│   │                               remaining + domains (submitted/public/… → a
│   │                               plain domain list, for targets-select --ledger
│   │                               and anyone else who just needs the exclusion set)
│   ├── discovery-queue.mjs         recursive competitor/commenter expansion
│   ├── footprint-discover.mjs      Google search-operator footprints (`inurl:submit`,
│   │                               `"write for us"`, …) → submission-page leads.
│   │                               Collects + shape-scores only, per
│   │                               <law-ref id="scripts-collect-ai-judges"/>; stops
│   │                               and leaves a scene on any CAPTCHA signal rather
│   │                               than working around it. Real Google only — see
│   │                               its header comment for why anysearch/Bing/DDG
│   │                               cannot substitute. Method and the effective/noisy
│   │                               footprint table: references/discovery-loop.md
│   │                               § Footprint discovery
│   ├── harvest-commenters.mjs      pull commenter domains off an article
│   ├── third-party-list-ingest.mjs someone else's list → screened leads + diff
│   ├── fingerprint-forms.mjs       ★ cluster targets by FORM SHAPE, not by site. Field
│   │                               names are stable across every install of a family,
│   │                               so one adapter covers twenty sites. This is what makes
│   │                               batch cheaper than walking 150 forms by hand.
│   ├── probe-submission-targets.mjs leads → reachability, route, gate, price; dumps the
│   │                               raw HTML per domain into `<out>.evidence/` — the
│   │                               classification is a suggestion, the HTML is the record
│   ├── lib-probe-classifier.mjs   ★ the probe's classification layer (decide/classifyKind/
│   │                               gatesFrom), separately unit-tested; every output is
│   │                               `suggested: true` and the AI may overrule it against
│   │                               the dumped raw HTML
│   ├── merge-submission-targets.mjs fold a probe run into the two data files. Drops nothing
│   │                               silently: every dead/unverified row is printed in full
│   │                               (and written by --dropped-out) with its reason and
│   │                               evidence, and the usable→gated downgrade is listed as
│   │                               derived-from-the-gate-set, not applied in silence
│   ├── lib-cohort.mjs              ★ the shared cohort/gate vocabulary — targets-select,
│   │                               validate-data, probe and merge all read it. Change a
│   │                               cohort name here, not in four places.
│   ├── targets-select.mjs          pick ONE batch: --cohort open | captcha | … ;
│   │                               reads the project ledger by default (submitted-
│   │                               or-later AND rejected excluded, no flag needed;
│   │                               --include-rejected to reopen a dead one on purpose)
│   ├── paid-platform-registry.mjs  merge a harvest into the paid registry
│   ├── harvest-*.{sh,mjs}          bulk table extraction from logged-in dashboards
│   └── harvest.browser.js          generic virtual-scroll table extractor: rebuilds rows
│                                   by Y-coordinate clustering, adapts to column drift.
│                                   NOTE the dot — the harvest-* glob above does NOT match it.
│                                   NOT the first choice any more: scripts/ground-truth.mjs
│                                   pierces shadow DOM, finds the inner scroll container,
│                                   and pairs every read with a screenshot. Come here only
│                                   when you need a whole table exported as a file.
│
└── references/           ← method, traps, and why the rules are the rules
    ├── browser-runtime.md     ★★ READ FIRST for any browser work. The laws + measurements.
    ├── traffic-screen.md      ★ the qualifying gate, and why it runs before the form
    ├── submission-lanes.md    ★ lanes, cohorts, the three guards, staged queues
    ├── instant-publish.md     ★ free channels: how each class behaves, what kills them
    ├── paid-platforms.md      ★ paid: tiers, why a burst is not a purchase
    ├── batch-campaign.md      ★ 100+ rows: queue, idempotency, resume, reporting
    ├── directory-run-playbook.md ★ what a real run hits: hidden free tiers, already-listed sites, stale ledger rows
    ├── index-submission.md      index-only channels; why `indexed` must name an engine
    ├── authorized-data-sources.md  the panel, the cards, quota, expiry, the traps
    ├── field-notes.md           what actually blocks submissions in practice
    ├── harvest.md               scraping failures that look like success
    ├── pagination-harvest.md    tables with hundreds of pages: which paging mechanism,
    │                            what a full crawl really costs, how to sample without bias,
    │                            and how to notice rows silently going missing
    ├── safety-policy.md         read before any fill / submit / logged-in action
    ├── acquisition-doctrine.md  the standing ruling on what is worth pursuing
    ├── discovery-loop.md · link-quality-rubric.md · analysis-templates.md
    ├── outreach-templates.md · backlinkdirs.md · prompts.md · credits.md
    └── LICENSE-analysis-templates-Apache-2.0
]]></tree>
