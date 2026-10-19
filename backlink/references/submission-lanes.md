# Submission lanes, cohorts, and the three guards

A submission run splits in two, and the split is the whole point of the cohort
tags. Both lanes produce work; neither is a leftover.

| | Lane A — unattended | Lane B — staged queue |
| --- | --- | --- |
| Cohorts | `open` | `captcha`, `account-captcha`, `email-verify`, `manual-review` |
| What the driver does | fills, clicks the real submit control, reads the result | fills **everything it is allowed to**, walks to the final step, and **leaves the page open** |
| Ends at | `submitted` / `outcome-unknown` | `staged-captcha` — a form on screen needing a code and a click |
| Who finishes it | nobody | the owner, in one sitting, seconds per site |

The driver never types a CAPTCHA answer, never pays, and never ticks a terms
box — those stop the row and move it to Lane B with whatever could legitimately
be filled already in place. It **does** create accounts: the owner has
authorized registration, and the one thing a script cannot do — read the
mailbox — is handled by the separate `mailbox` Skill (see below).

## Account registration and email verification (`mailbox`)

`account` and `email-verify` are no longer "wait for a person" cohorts. The
registration itself is scripted; the verification mail goes to the **`mailbox`
Skill**'s domain, which owns the receiving side (Cloudflare Email Worker → D1 →
`read_mailbox.py`). That domain is a catch-all, so any local part reaches the
same inbox. This is the key that turns Lane B's account half into real work.

1. Open the target's sign-up route in that row's **own** session.
2. **Before typing an alias, look for one-click OAuth** — "Continue with
   Google/GitHub/X" buttons on the login or sign-up page. A dedicated browser
   profile often already carries a live session for at least one of those
   providers, which finishes registration with a single Authorize click and no
   mailbox round-trip at all. Real failure mode (2026-10-20): an agent skipped
   an `account`-cohort target as "requires registration" while its login page
   offered three one-click buttons and the profile held a valid GitHub session.
   Skimming `accounts.json`/provider sessions costs seconds; skipping a
   registrable target costs a listing. Only when no one-click path exists, fall
   through to the alias flow below.
3. Register with a **per-target alias** on the mailbox domain — the shared form
   is `<project>-<target>@<mailbox-domain>` — plus the profile's submitter name.
   Never one fixed address across targets (it fingerprints the batch), never
   invent a third-party address, and never reuse someone else's account. Keep
   the alias → target mapping in the accounts store, never in the ledger.
4. Submit, then poll the mailbox filtered by the sender's domain — use `ts` to
   tell new mail from old; there is no push, only polling.
5. Open the activation link, or enter the OTP, **in the same session**, then
   continue to the listing form.
6. Record the account in the ledger row's evidence (and note the OAuth provider
   when one-click was used). Record **never** the credentials, and never a
   token.

Stop the row as before if the mailbox Skill is unavailable, or if finishing the
sign-up still needs a CAPTCHA/Turnstile, a phone number, a company/personal
address, or payment — those stay Lane B.

## Lane B needs one session per staged site

**N staged forms need N session names.** A session owns one tab, so reusing a
single session overwrites the previous staged form and the queue silently
becomes a queue of one — while the report still says N staged. Do not reach for
`tab new` to solve this; see Law 2 in [browser-runtime.md](browser-runtime.md)
for why that API cannot hold several pages.

`scripts/adapter-phpld.mjs` carries the correct pattern:

```js
const sessionFor = (url) => `${base}-${new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`;
```

Hand the owner the session list, not a list of URLs to re-enter by hand.

## Run one cohort at a time

Every target carries **all** the gates observed on it in `gates`, and a `cohort`
derived from that set. The cohort is the batch it belongs in, because the
cohorts cost different things:

| Cohort | What the run needs |
| --- | --- |
| `open` | nobody. The only cohort that needs no second party at all. |
| `captcha` | a human at the keyboard for the whole run |
| `account` | the `mailbox` Skill for the verification mail; the identity is a standing decision, not a per-row one |
| `account-captcha` | both of the above |
| `email-verify` | the `mailbox` Skill polled while the run is going; tokens expire mid-batch |
| `reciprocal` | a change to the owner's own site — their decision, never yours |
| `personal-contact` | real name / phone / company email — also the owner's decision |

**Mixing cohorts in one run is what makes a batch stall.** The open rows finish
in minutes and then everything waits on a person nobody told to be there. Pick
one cohort, run it to the end, then pick the next.

```bash
node scripts/targets-select.mjs --stats                     # cohort x payment matrix
node scripts/targets-select.mjs --unattended --free-only    # the run needing nobody
node scripts/targets-select.mjs --cohort captcha --limit 40 # the next session
node scripts/targets-select.mjs --cohort account --format urls
```

Two details that are easy to get backwards. `captcha-passive` does **not** put a
target in the `captcha` cohort — it clears itself in an ordinary browser and
costs the run nothing; treating it as a challenge pushes open targets into the
queue that needs a person. And `--free-only` keeps `payment: "optional"`,
because a free listing behind a three-month queue is still free — it drops only
`required`.

`gate` (singular) remains the single answer to "what stops me here first",
ranked by **cost**, not by DOM order: a demand for a phone number outranks an
account, which outranks a CAPTCHA. All four values — `gates`, `gate`, `cohort`,
and the ban on `usable` when a human gate exists — are derived in one place,
`scripts/lib-cohort.mjs`, and the validator recomputes them. Deriving a cohort
by hand in a report is how a target reads `account` in the data and `open` in
the plan, which is worse than having no label at all.

## The three guards, each of which exists because it was needed

A generic form driver run across a directory list will, unsupervised, do worse
than nothing — a listing is a permanent public record, and the brand's official
mailbox is attached to it. All three were added after a real batch run did the
wrong thing:

1. **No URL field, no submission.** A directory submission always has one. A
   form without one is something else on the page, and that something else is
   usually a newsletter box — so the alternative to this check is subscribing
   the official address to strangers' mailing lists while reporting it as link
   building. The scorer picked exactly such a form on a live target.
2. **The submit control must read like one.** On another target the "submit
   labels" came back as four product names, meaning the scorer had found page
   buttons rather than the form's own action. A control whose label is not
   submit/send/add/post/next (or the CJK equivalents) is refused, not clicked.
3. **`requestSubmit()` is not a click.** Forms wired to a handler on the
   *button* ignore it, and the page then looks exactly as it does after a silent
   success. Click the real control and confirm against something other than the
   page text.

And the rule that outranks all three: **a generic driver classifies, it does not
certify.** Its `submitted` means the form was accepted, never that a listing
exists — that is `public`, and it needs the anchor seen on a live page.

## Building or extending the target library

```bash
# 1. someone's list → deduped leads
node scripts/third-party-list-ingest.mjs --input THEIR-LIST.md --out .backlink/leads.json

# 2. leads → reachability, real route, earliest gate, price on the page
node scripts/probe-submission-targets.mjs --input .backlink/leads.json \
  --out .backlink/probed.json --concurrency 12 --resume

# 3. fold in (paid rows route themselves into paid-platforms.json).
#    --dropped-out keeps every row the merge did not write, in full, with its
#    reason and evidence — re-probe from that file instead of losing the row.
node scripts/merge-submission-targets.mjs --probe .backlink/probed.json \
  --source-list 'where this came from' --dropped-out .backlink/dropped.json --dry-run

# 4. pick a batch and run it
node scripts/targets-select.mjs --cohort open --free-only
```

Step 2 is anonymous HTTP, so it is honest only about what **is** present. Rows it
cannot resolve come out `unverified` and need a browser or a human before they
mean anything; the merge keeps them out of the target table rather than letting
them pad a count — but **it does not throw them away**. Every dropped row is
printed in full and, with `--dropped-out`, written back out with its reason and
evidence, because `unverified` is a statement about **the probe**: a 403 from a
WAF, a timeout, and a domain that genuinely has no form all produce it. The same
listing covers the `usable` → `gated` downgrade, which the merge *derives* from
the gate set rather than observing, and therefore names as derived.

Since 2026-08-30 step 2 is split in two layers: the probe itself only fetches
and **dumps each domain's raw HTML into `<out>.evidence/<domain>.html`**; the
`status`/`gate`/`cohort`/`kind` on every row come from
`scripts/lib-probe-classifier.mjs` and are **suggestions** (`suggestedBy` on the
row, `suggested: true` inside the classifier output). When a row looks wrong —
a "usable" that gates on step 2, an "unknown" that is obviously a directory —
read the dumped HTML and overrule the suggestion; do not re-run the probe
hoping for a different regex outcome.
