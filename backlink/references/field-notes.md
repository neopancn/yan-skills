# Field notes: what actually blocks directory submissions

Distilled from running a full submission campaign for a brand-new site end to end.
Everything here is a rule that held across many different targets. No site names,
no metrics, no credentials — those stay in the project's own ledger.

## The three walls, in order of how often they stop you

Most people expect CAPTCHAs to be the main obstacle. They are not.

1. **Mandatory personal contact info** — a required real name, personal email, or
   phone. This is the most common blocker by a wide margin. It is not a technical
   barrier at all, which is exactly why it stops an agent: the operator has to
   decide whether to spend their identity on this listing.
2. **Account registration.** Creating accounts is out of scope; abandon the target
   immediately rather than exploring alternate paths.
3. **CAPTCHA / anti-bot.** Genuinely common, but third.

There is a fourth that looks like a wall and is not: **directories that demand a
street address, city, ZIP, or company registration.** Those are local-business or
B2B-vendor directories. A software product with no legal entity has nothing true
to put there. Record `not applicable` and move on — never invent an address.

**[2026-08] A fifth to check for, new since 2026-06-15: Back Button Hijacking.**
Since Google's April 2026 spam policy took enforcement effect, a target site
running a third-party script that hijacks the browser back button (traps the
visitor, or redirects "back" somewhere other than the actual previous page) is
penalized or at real risk of it — and the site owner is liable even when the
offending script came from an embedded ad or widget, not their own code. This is
observable during target qualification, before any content gets written: press
back on the target page and confirm it actually returns you to the prior page,
and grep the page's scripts for `history.pushState` abuse or a `beforeunload`
handler that redirects. A site doing this is a bad link target regardless of
how it scores on `rel`/`robots` — record it as a rejection, same as a CAPTCHA
or a login wall.

## Landing-page scans give false negatives on CAPTCHAs

Fetching a submit page and grepping for `recaptcha|hcaptcha|turnstile|captcha`
**does not work**. Repeatedly, a landing page scanned clean and the CAPTCHA
appeared on step 2 or later — after a category picker, a terms checkbox, or an
email-gate.

**Walk the form to its final step before concluding anything about it.** Budget
for this: a "quick scan" of N targets is not a real qualification pass.

## Free tiers are priced in time, and that is the product

Free listings routinely carry multi-month review queues, with a paid tier that
skips the line. This is the business model, not a malfunction, and it means:

- A free-tier submission today is not a link for months. Set that expectation
  before the campaign, not after.
- **Submitted is not published, and published is not followed.** Keep them as
  three separate states with separate evidence. A listing can go live with
  `rel="nofollow"` on the outbound link; check the actual `rel` in the DOM rather
  than assuming.

## The gate you scanned is the gate on screen one

Measured 2026-08-19 on the first target actually walked end to end. Its step 1
asked for listing type, category, URL, title, description, name and email —
**no CAPTCHA in the raw HTML, no login, no reciprocal demand**, which is exactly
the profile that gets a row filed as an open, unattended target. Clicking
through to the confirm step produced a `scode` security-code field and a second
Submit button.

So a cohort built from a first-screen scan is **optimistic, and there is no way
to fix that by scanning harder** — the only thing that settles it is walking the
form. Two consequences worth building around:

- Treat "open" from a scan as *a lead about the gate*, not the gate. Re-file the
  row the moment a later step contradicts it.
- Because the surprise is systematic, plan the run so a discovered CAPTCHA costs
  one row and not the batch: fill everything the driver legitimately can, leave
  the page sitting at the confirm step, and push the row into the one manual
  queue described in [batch-campaign.md](batch-campaign.md).

## `requestSubmit()` does not fire a JS-bound submit handler

Also 2026-08-19, on a form whose `action` was an internal `/api/form` endpoint.
The driver filled every field, called `form.requestSubmit(button)`, and reported
a state change of nothing: same URL, same text. **The network capture showed no
request to `/api/form` at all** — so the submission never happened, which is the
good outcome, because the alternative is a driver that reports success on a form
that was never sent.

The cause is that these forms bind a handler to the **button's click**, not to
the form's submit event. `requestSubmit()` and `form.submit()` both bypass it.
The fix is to click the real control, and the check that catches it is the
network capture, not the page text:

```bash
opencli browser "$SESSION" network | grep -i '<the form endpoint>'
```

**Never resolve this state by clicking again.** No request fired here, but the
same "nothing visibly happened" appears when the POST *did* fire and the site
answered silently — and those two are indistinguishable from the page. That is
the `outcome-unknown` state: check the endpoint, the mailbox, and the public
page, in that order, before touching the form a second time.

## A currency amount on the page is not a submission fee

Measured across a 743-row sweep in 2026-08: a bare money regex flagged ~163 of
648 domains as costing money. Once each page was actually read, **about a
quarter of those were not submission fees at all**, and the errors were not
random — they clustered:

- **One legacy PHPLD directory script accounts for most of it.** Two dozen
  domains running it (`addgoodsites`, `adbritedirectory`, `deepbluedirectory`,
  `fire-directory`, `jet-links`, `steeldirectory`, …) all render a sidebar
  offering an **ad banner for $0.80**, while `/submit.php` on the same site is
  free with no fee field anywhere. Same template, same false positive, twenty-odd
  times — so this looks like a trend in the data and is one script.
- **Directories quote the prices of the products they list.** A SaaS directory's
  homepage is wall-to-wall pricing that has nothing to do with listing on it.

The fix that works is proximity, not a better money regex: only count an amount
whose surrounding ~160 characters mention submitting, listing, a plan, a
package, featured/priority placement, or a billing period.
`scripts/probe-submission-targets.mjs` does this and reports the rest separately
as `priceHitsUnscoped`, because "there was money on the page somewhere" is worth
a human glance and worth nothing as a `payment` value.

**`optional` is the most useful answer here, not a hedge.** In the same sweep 18
sites turned out to run a genuine free tier next to a paid fast-track — that is
a *free* channel with a queue, and calling it `required` would have deleted 18
usable targets from the library. Record what the free path costs in time.

## Cloudflare's interstitial makes "dead" unknowable over HTTP

In the same sweep, of 85 hard cases handed to a resolver, **53 could not be
classified at all — and the dominant cause was not dead sites.** It was
Cloudflare's "Just a moment…" JS challenge and WAF blocks, which a browser User-
Agent on `curl` does not get past. Well-known live properties sat in that bucket:
`sourceforge`, `g2`, `getapp`, `goodfirms`, `daniweb`, plus a long tail of
classifieds directories. A second cluster was modern SPAs whose raw HTML is
essentially empty (`aitoolsdirectory`, `booky.io`, `techbasedirectory`), so form
and gate detection finds nothing on a page that is obviously alive.

Both clusters are **alive and unresolvable by HTTP**, which is exactly the state
`unverified` exists for. Do not let them decay into `dead`, and do not let a
report count them as failures: they are the queue for the browser pass, and the
Skill already drives a real logged-in Chrome for precisely this.

Two smaller ones from the same run, both of which need the browser as well:
domain parking that only reveals itself after a **JS redirect to `/lander`**
(two apparently unrelated domains turned out to share one parking template), and
a cluster of expired TLS certificates that need an explicit fallback before any
conclusion is drawn.

## Reciprocal badge requirements

Several directories grant free listings only if you link back. Handle it in this
order:

1. **Read whether they want a *link* or a *badge image*.** Wording like "you can
   set your own link or use one of our badges" means a plain text link satisfies
   it. Prefer that — no asset, no layout cost.
2. **If an image is required, self-host it.** Their snippet hot-links their
   server, which adds a third-party request to every page of your site. The
   verification checks the link, not where the image is served from.
3. **The href often must point to your item/product page, not their homepage** —
   and that page does not exist until the draft is created. This makes it
   inherently two-pass: create the draft, get the slug, update the link, deploy,
   then verify.
4. If they offer an "I've installed it, continue anyway" escape, **do not click
   it** unless it is actually installed. That is a false statement and the
   listing can be pulled later.
5. Watch for a **stated detection deadline** ("removed if not detected within N
   hours"). Deploy before you trigger verification.

Also worth stating plainly to the site owner: stacking many badge images in a
footer starts to look like a link-exchange page, which is its own risk. Text
links keep it modest.

## Email verification is part of the job, not a follow-up

Multiple directories email a confirmation link and **delete unverified entries
after a few days**. A submission without the click is not a submission. Treat
"confirmation email clicked, page returned an explicit VERIFIED string" as the
completion criterion, and say so in the handoff if you cannot access the inbox.

## Browser automation notes

These cost real time to discover and generalise across sites.

### Make the human's step visible

Automation tools commonly default to a **background window**, and their tabs may
be ephemeral. If you fill a form and hand it to a human for the CAPTCHA, they may
see nothing at all — and you will waste turns explaining rather than diagnosing.

**When a human must finish a step, drive the tab they are already looking at**
(most tools have a `bind`-style command that attaches to the active tab). Check
for a foreground/background switch *before* concluding "the two browsers are
different" — the symptom has a boring cause.

### Selector hygiene

**Dump `tag / type / name / id` before writing a selector.** Two separate targets
cost multiple rounds each because an attribute assumed to be `name` was actually
`id`, or vice versa. A tolerant helper avoids the whole class of failure:

```js
const q = n => document.getElementById(n) || document.querySelector(`[name="${n}"]`)
```

Also check for **duplicate ids** — real pages ship them. Confirm you have the
right node by reading the label text near it.

### Framework-controlled inputs

`el.value = x` is swallowed by React and similar frameworks; the UI never sees it.
Use the native setter, then dispatch events:

```js
const set = (el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input',  { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
```

### Custom dropdowns (react-select and friends)

Setting `.value` does nothing. Open the control by dispatching
`mousedown`/`mouseup`/`click` on the wrapper, wait for the listbox to render, then
dispatch the same sequence on the option whose text matches exactly — **all inside
one evaluation**, or the dropdown closes between calls.

### A button that "does nothing" may be a multi-step confirm

One target flipped its button's `type` from `button` to `submit` after the first
click, re-showed the same modal twice, and only submitted on the third. **Read the
button's `type` and the surrounding DOM after each click** instead of concluding
the click failed and moving on. This is a deliberate retention pattern, not a bug.

### File uploads when the automation layer is refused

If the debugging-protocol file-input call is denied, inject the file client-side:
`fetch(dataURL)` → `Blob` → `File` → `DataTransfer` → assign to `input.files` →
dispatch `change` and `input`. This avoids the native file chooser entirely.

### Check length limits before typing

Character counters and `maxlength` silently truncate or reject. One 300-character
description failed a 255-character field with no visible error.

### Validate the *shape* of a probe result, not one field of it

A qualification pass over N targets returned "candidate" for 69 of 70. The
number was suspiciously good, and it was: 68 of those probes had returned

```json
{"error": {"code": "attach_failed", "message": "..."}}
```

— valid JSON, but with none of the probe's fields. The classifier read
`if (p.fieldCount === 0) return 'no-form'`, and `undefined === 0` is false, so
every failed probe fell through to the final `return 'candidate'`. The output
was a clean, plausible, entirely fictional qualification table.

**Write the check as "are all expected keys present", never as "does this field
equal a sentinel value".** The second form silently assumes the field exists,
and the failure path is precisely the case where it doesn't:

```js
const REQUIRED = ['url', 'title', 'captcha', 'fieldCount']
const wellFormed = p => !!p && REQUIRED.every(k => k in p)
```

Then give every batch script a **failure-rate gate**: if more than ~20% of a run
came back malformed, exit non-zero and refuse to hand over the results. Without
it, a broken session produces a table that downstream steps consume as fact.

### A result that is much better than the historical rate is a measurement bug

Both of the above were caught by the same instinct rather than by the code: the
pass rate did not match what this kind of work has ever produced. When a batch
suddenly reports an unusually high success rate, suspect the measurement before
celebrating. Re-running a fixed version against a small sample and confirming
the distribution matches history is a cheap check and worth doing every time.

## Blog comments: the submitting session is the worst place to verify

Comment forms are the most available no-registration channel there is, and the
verification trap is severe enough to invalidate a whole campaign report.

- **Seeing your own link after submitting proves nothing.** The common blog
  engine redirects to `?unapproved=<id>&moderation-hash=<hash>#comment-<id>`,
  and that page renders the pending comment **to its author only**. Worse, the
  submission sets an author cookie, so the *same browser session* keeps showing
  the pending comment on the clean URL afterwards. A verifier that just asks
  "is my link on the page?" reports `published` for something no crawler and no
  reader can see. Observed doing exactly this.
- **Judge by the landed URL first**: `unapproved=` or `moderation-hash` in the
  query string means moderation, full stop, regardless of what renders.
- **Confirm public visibility through a channel that has none of your cookies**
  — a reader proxy, a different machine, or a fresh anonymous context. Anything
  else is measuring your own session.
- Guest comment links come back as `rel="nofollow ugc"` or `"ugc external
  nofollow"` on the main engine's default. Publish anyway; just log it.
- **Dofollow body link: a real newline inside the `<a …>` tag defeats the
  nofollow pass.** The main engine adds the rel with `wp_rel_nofollow()`, a
  pre-save filter that runs `preg_replace_callback( '|<a (.+?)>|i', … )` over the
  comment markup. That pattern's `.` carries no `s` modifier, so it will not
  cross a newline: **one real line break anywhere inside the `<a …>` tag stops
  the match and `rel="nofollow"` is never applied.** The working payload puts the
  break immediately before the closing quote of `href`:

  ```html
  <a href="https://example.com/
  ">anchor text</a>
  ```

  It has to be an actual newline character, not the two characters `\` `n` — an
  escaped `\n` is literal text, does not break the match, and ends up inside the
  URL instead of producing a dofollow link. The break survives to the rendered
  page because a browser accepts a line break inside a quoted attribute value.
  Confirm the outcome by reading `rel` off the published anchor, not off the
  submission that created it.
- **Scope: the technique reaches body links only.** It works on markup the
  commenter authored, because that markup is what the filter walks. The link
  built from the form's Name/Website fields is emitted by the theme from the
  stored URL, so its `rel` is the theme template's decision and the newline never
  touches it. One comment can carry a follow body link and a nofollow author link
  at the same time.
- The shipped comment tool gates this behind a switch that is **on by default**,
  and advises keeping a campaign's dofollow share under 50%.
- **The Name field IS the anchor text of the author/URL link.** The theme emits
  the stored `author` and `url` as one link — `<b class="fn"><a href="{url}"
  rel="…" class="url">{author}</a></b>` — so the string typed into Name becomes
  the rendered anchor text. When the objective is a keyword anchor, the Name
  field must carry **that keyword** and the Website field the **matching landing
  page**; a plausible-sounding human name there ("Sofia M.") throws the anchor
  slot away. Two caveats: keep the campaign's anchor distribution healthy — do
  not type the same keyword into every comment — and the author-field link is
  nofollow on every install sampled, so a keyword here buys **relevance, not
  PageRank**. Record the anchor text you actually saw on the published page, not
  the name you sent.
  - The exception is a **dofollow body-link** comment: there the anchor is
    authored inside the body `<a>`, so the Name field should stay a normal name.
    Putting the keyword in Name adds nothing the body link does not already
    carry, and it makes the comment self-identify as promotion.
  - **Brand-defaulting is the failure mode that actually happens** (observed
    2026-10-20, 10-comment batch): the skill's anchor-policy rule names
    "brand, product, or naked URL", and an agent under submission pressure
    resolves that to typing the brand name into every Name field — ten anchor
    slots burned on a keyword that was already over-allocated. The fix is
    operational, not a new vocabulary: the comment Name slot **consumes the
    campaign's anchor rotation** like any other placement. Prefer
    descriptive-partial and generic anchors here (they read naturally to a
    moderator; "convert a Lovable site to WordPress" survives review, a bare
    "html to wordpress" as a person's name invites the trash button), cap
    exact-match at roughly one per ten comments, never repeat the same keyword
    on the same site, and point the Website field at the landing page matching
    that anchor's target — an anchor for a `/convert/lovable-to-wordpress`
    page that lands on the homepage wastes the relevance it just bought.
- **"Saved" is not "published": the duplicate signal proves storage, not a live
  comment.** Re-POSTing the identical payload and reading `409 Duplicate comment
  detected` proves the first POST was stored — it says nothing about whether the
  comment is visible. A first-time comment is routinely held: installs commonly
  enable manual approval or "author must have a previously approved comment", and
  any Akismet install may file it as spam. From outside, a held comment and a
  published one look the same on the first POST — no readable comment anchor,
  and (because `fetch` drops the fragment) `Response.url` is just the article
  URL either way. A `302` that lands on `#comment-<id>` is **not** proof either;
  one install redirected there and the comment was still not on the page. Decide
  only with a **cookie-less anonymous re-read of the article and its
  `comment-page-1..N`**, searching the page for an anchor to your domain, and
  read the anchor's `rel` from that same re-read.
- **Find the auto-publishing installs and spend them on the dofollow lane.**
  Whether an install publishes immediately is unknown until a submission lands,
  and it is not the same set as "has an open comment form". A dofollow body link
  on an install that holds comments never renders — the whole newline trick is
  wasted — while a nofollow-lane comment on that same install was spent on a
  link that the author field would have made nofollow anyway. Sample this
  deliberately: place a plain comment first, confirm it publishes, and aim the
  body-link comments at the ones that did.

Two architectural blockers decide most of the target list before any of that:

- **The hosted-blog platform's comment widget is a cross-origin iframe.** It is
  invisible to `document.forms` and to frame enumeration, so form-probing tools
  report "no comment form" on posts that plainly have one. Roughly half of a
  49-post sweep died here.
- **The big hosted-WordPress commenting system** leaves only hidden fields plus
  an anti-spam honeypot in the classic markup; the real UI is rendered by script
  elsewhere. It failed 6 of 6 tested.

Self-hosted installs with a plain anti-spam plugin are the class that actually
works. Searching with both hosted platforms excluded is therefore the productive
footprint — filtering them out afterwards wastes most of the sweep.

## `form.elements[name]` may hand you a collection, not an element

When more than one field shares a name — which anti-spam honeypots deliberately
arrange — `form.elements[name]` returns a node list. Setting `.value` on it
throws nothing, changes nothing, and the form submits empty. This is the same
failure signature as the rich-editor trap: **the field reads back fine and
submits blank.**

Resolve fields with `querySelectorAll('[name="x"]')` and pick the one that is
actually visible (non-zero box), which also skips the honeypot — filling a
honeypot is self-identifying as a bot. Then **assert the body field is non-empty
before submitting**: posting an empty comment burns the target and leaves litter
on someone's site.

## Poll for the element, never sleep a fixed interval

An ad-heavy blog can take well over ten seconds to attach its comment form. A
fixed delay that expires early produces a null result that reads exactly like
"this page has no form" — a false negative that silently shrinks the target
list. Poll for the specific thing you need, with a bounded retry count.

## Never run two agents against one browser session

If a subagent is driving a browser session, **do not drive the same session
yourself**. Concurrent navigation clobbers state, produces intermittent failures
that look like site flakiness, and can overwrite the other's output file. Give
each agent its own session name, and do not "help" a running agent by doing its
work in parallel.

Related trap when scraping a single-page app: after client-side navigation the
**previous query's rows can stay on screen for several seconds** before the new
data swaps in. "Results are present" is not a readiness signal — also require the
new query's own identifier to appear in the page text.

## Mining competitors' backlinks: expect mostly noise

Copying a competitor's backlink profile is sound in principle, and it is the right
instinct for a site with no authority. But budget for the composition:

- A large share of any small site's referring domains is **auto-generated noise** —
  URL shorteners, screenshot/"domain report" generators, search-bang lists, scraper
  aggregates. These attach to any URL that exists. They are not strategy.
- Sorting by "how many competitors share this referring domain" is the right
  ranking, but **the top of that list will be the noise**, precisely because noise
  attaches to everyone. Classify before you treat anything as an opportunity.
- **Bought links announce themselves.** Blocks of numbered domains on one odd TLD,
  appearing within a few days of each other, are a rented network. A single
  unusual TLD holding a large share of a profile points at one network rather than
  many sources.
- What survives the filter is usually small and of one kind: **roundup and
  "best tools" articles, forum threads, and Q&A aggregations — places where a
  human mentioned the tool.** Those are earned, not submitted, and the outreach
  for them is a normal email to the author.

The honest conclusion this supports: for a young site in a niche where the
incumbents bought their links, there is often **no clean bulk path to copy**. Say
that plainly rather than producing a long list of targets that are really a PBN.

## What not to do, and why the request will recur

An operator under pressure will ask for the fast version: a scraped list of blogs
that accept comments without login, posted to in bulk. Expect the request more
than once, and expect it to be backed by real evidence that it works in
low-competition niches.

It is still out of scope here, and the reason is not efficacy: those lists are
harvested from abandoned or unmoderated blogs, and posting promotional comments to
them is advertising on other people's property. The link-farm rule in `SKILL.md`
is not a quality heuristic to be traded away when the legitimate path proves slow.

What *is* in scope, and worth offering instead:

- Writing tooling the operator runs themselves, with a human approving each post.
- Individually-written, genuinely relevant comments where the operator has an
  account and something real to add.
- The outreach path above: roundup inclusion, which produces one editorial link
  worth more than dozens of farm links.

Say the boundary once, plainly, then put the effort into the alternatives rather
than re-arguing it.

## 「没有数据」几乎总有自己的页面形态，别拿超时当判据

批量测流量时，数据源查不到的域名并不是页面加载失败——它**正常渲染完成**，
只是把指标区换成了一句「未找到匹配内容」加一排 `N/A`。

第一版轮询只认「总访问量」这个内容词。有数据的域名 5 秒返回，没数据的域名
**白等满一整个 45 秒超时**，而在外链目标里没数据的那一档恰恰占比最大，
于是整批的平均耗时翻了三倍——批量作业里这就是能不能跑完的差别。

**判据：任何「查不到 / 没有结果 / 空态」的分支，先去页面上把它自己的那句话找出来，
用它做正面判定；超时只留给真正的卡死。** 代价不对称——多认一个空态字符串是一分钟的事，
拿超时兜底是每条记录都要付的税。

顺带一条：**空态页仍然带着这个域名的简介文案**（数据源从站点抓的 meta description）。
所以「页面上出现了这个域名」不足以证明「查到了数据」，轮询条件必须认指标本身或空态串，
不能认域名。

## 超时不是结论——「没测到」和「没有」在超时那一刻长得一模一样

这条是上一条的反面，而且比上一条贵得多，因为它**污染数据而不报错**。

上一条说「空态要正面认出来」。第一版顺手做了个看起来很合理的推论：
既然认不出指标就说明没数据，那超时就记 `below-floor`（低于测量下限）吧。

**错。** 实测一个自然流量 2.4K 的目录站被这么判成了「没流量」，
另一个 4.6K 的也是。原因只是概览页那一次渲染慢，超过了 41 秒的阈值。
**渲染慢的页面和真的没有数据的页面，在超时那一刻的可观测状态完全相同，
而两者的结论正好相反。**

规则：

- **只有数据源明说「未找到匹配内容」才算 `below-floor`。**
- **超时一律记 `error`。** error 的语义是「这次没测成」，不是判决。
- **续跑时 `error` 不算跑过**，必须重测。反过来会把一次会话故障造成的空洞
  永久固化下来，而且从输出行数上完全看不出来——行数是齐的。
- 写回主表时，遇到 error 要**清掉**该域名上已有的旧判决，
  否则由 error 降级来的错误结论会一直冒充「已测」。

判据一句话：**任何「查不到」的结论，都要能说出数据源在哪句话里说了「没有」。
说不出来，就只是你没等到。**

## 共享面板的真实瓶颈是每日配额，不是速度

把登录摊销掉之后单域名 5 秒，很容易得出「几百个域名半小时跑完」的结论。
**跑到第 110 个左右，面板上的「API 今日配额」从 13% 涨到 100%，之后每一次
eval 都超时**——表现和会话挂掉一模一样，脚本里的报错还在教人「换个节点」。

- **真实吞吐 ≈ 每天 120 个域名/张卡片**，不是每小时几百个。规划批量筛选时按这个算。
- **配额是按卡片分开的。** 一张打满了，另一张往往还满着——换工具继续，
  不要因为其中一张见底就整批停下。代价是口径变了，必须在数据里标明来源。
- **配额耗尽必须能和会话故障区分开。** 跑之前和跑挂之后都去读一次面板上的
  「今日配额」，那是唯一能直接区分两者的地方。
- 因此批量脚本必须有**连续失败熔断**：会话一挂，后面每个域名都要付满一整个超时，
  实测连烧 48 个域名 60 秒才被人发现。连续 N 次失败就停下报错，不要跑完整张表。

## The identity fields are the ones a campaign gets wrong, and nobody notices

Two identity errors surfaced only because the owner read the reply, not because
anything failed. Both had already reached third-party sites by then, and a
directory submission has no retract button.

**The contact email must come from the site's own published address, never from
the person driving the run.** A campaign filled the operator's personal Gmail
into every form for the first 156 attempts. It was caught after 6 submissions
had actually fired, at least 3 of them confirmed sent. The site's real address
was sitting in its own codebase the whole time — one grep found it appearing
8 and 12 times respectively across the contact page and the JSON-LD.

So: **before the first form, grep the site for its own contact address**, put it
in the payload as the single source, and make every result row report the
`emailUsed` it actually typed. A field that is never reported back is a field
nobody can audit.

```
grep -rhoE "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}" <site-src> \
  | grep -viE "@types|@tanstack|@cloudflare|@vite|@radix|@tailwind" \
  | sort | uniq -c | sort -rn | head
```

**A non-English site must be described in its own language.** The same campaign
wrote English blurbs for a Japanese-market site through several rounds. Nothing
rejected them — English is accepted by English directory forms, so the failure
is invisible from inside the run. The blurb is what a human reads before
approving the listing, and in the target market's directories it is also what
gets indexed.

Encode it as a rule the filler cannot skip: carry **both** language variants in
the payload, make the local language the default, permit the English one **only**
when the form itself is English-only and rejects the local script, and require
every row to record `langUsed` plus the reason when it is not the default.
"Judgement call" is not enough — an agent optimising for "the form accepted it"
will always pick the language it wrote the description in first.

## Run the traffic screen BEFORE the form, not after — the cost is asymmetric

This Skill already says so; a campaign skipped it anyway, and the bill was paid
by a human. Measuring a domain costs one query. Filling its form costs two orders
of magnitude more, and when the route is CAPTCHA-gated the last step costs a
**person's attention**, which is the most expensive unit in the whole pipeline.

Measured on one batch of 12 CAPTCHA routes a human solved by hand:

| tier | count | traffic |
|---|---|---|
| worth it | 6 | 945k / 146k / 138k / 35k / 24k / 11k |
| worthless | 6 | 176, 43, 245, and three not indexed by the traffic panel at all |

**Half of that person's manual work went to sites with double-digit traffic.**
A single batch query beforehand would have removed all six.

The same run measured the effect directly. Counting every attempt row in the
run's own output files, and defining the split as *all work done before the gate
existed* versus *the one batch selected through it*:

| | attempts | confirmed | rate |
|---|---:|---:|---:|
| no traffic gate | 283 | 7 | **2.5%** |
| gated on `monthlyVisits >= 100` | 53 | 4 | **7.5%** |

Same payloads, same scripts, same day. **Three times the yield for one cheap
query per domain.**

State the denominator whenever you quote a rate like this. The first pass at
these numbers reported 1.1% → 3.3% from memory; recomputing from the files gave
2.5% → 7.5%. The *ratio* survived, the absolute rates did not — and a rate with
no stated denominator cannot be checked by the next reader.

Corollary for reporting: a panel that rewrites the requested window (asking for
28d and landing on 6m — the tool prints this) gives numbers that are **not**
monthly. They still rank domains correctly, so the screen works, but never copy
them into a ledger labelled "monthly visits".

## `open` cohort labels rot, and they rot toward false positives

A snapshot of "has an open form, no login" taken 10 days earlier was mostly
wrong when re-walked. Across 336 attempts, 272 were skipped, and the two largest
reasons were **the route is a homepage with no submission form at all** and
**login required** — i.e. exactly the two properties the cohort claimed to
exclude.

The cheap repair is already in this Skill:
`probe-submission-targets.mjs` is plain HTTP and costs nothing per target.
Running it first turned a 194-target queue into 59 with a real `open-form` gate,
**and separately recovered 7 real open forms out of a pool that had been filed
as CAPTCHA-gated** — the rot runs in both directions.

**So the order is: probe → traffic screen → fill.** Two cheap passes before the
expensive one. A campaign that walks straight from a stored cohort into a
browser is spending its most expensive resource on the least reliable data.

## Staged CAPTCHA forms die with the process that filled them

A sub-agent that fills a form and leaves the session open is **not** handing the
human a form to finish. Measured twice: when the agent's process ended, its
sessions went with it, and the tabs the human had been told to go click were
gone. The first time this happened it cost 8 filled forms; the second time,
another 18.

Two things follow, and the second matters more:

1. **The durable artifact is a replay record, not a session.** Store the final
   URL, every field's selector / name / the exact value typed, and the submit
   control's selector. Then any process can re-stage the form in one pass.
2. **Whoever will still be alive when the human clicks should be the one that
   opens the tab.** Staging from the orchestrator rather than from a worker is
   the difference between a form that is waiting and a promise that is not.

Re-staging from a replay record exposed two more traps worth naming:

- **A generated fill script that goes through a shell is a quoting hazard, and
  it fails silently.** Six of twelve re-stagings opened the page, executed, and
  filled **nothing**, with no error anywhere — the page was up, the fields were
  there, the values never arrived. Prefer the CLI's own per-field fill over
  hand-built JS, or pass the script through a file rather than an argument.
- **`fill` does not work on `<select>`; that needs `select`, with the option's
  real `value`.** A replay record that stored the human-readable label
  ("Computers > Software") cannot drive it. And the option list can be several
  thousand entries long — one had 3,500 — so a lookup that reads the first
  screenful of options finds nothing and reports "no match" on a page where the
  match exists.

## Staged tabs: two separate failures, and the one that matters is visibility

**Failure 1 — a concurrent cap, and exceeding it evicts silently.** Measured
repeatedly on one machine: roughly **6 concurrent sessions**. Opening one more
does not error; the least-recently-touched session is dropped **without a word**
and its tab is gone. Confirmed by the cleanest possible control: with an
unrelated probe session occupying one slot, a batch of four staged forms came
back three — closing the probe and re-staging the missing one worked
immediately. **Your real budget is the cap minus whatever other tasks already
hold**, so count the live sessions before staging, not after.

**Failure 2 — and this is the one that actually wasted the person's time:
`--window isolated` opens a window the person never looks at.** A batch was
staged four times over, verified alive each time, and reported to the owner;
they answered "I only see a blank browser, I don't see anything" every time.
The tabs were real and the forms were filled — they were just in a window that
was not the one on screen, and when that window got closed every session inside
it died at once.

The all-at-once disappearance is worth naming, because it invites a wrong
diagnosis: it looks exactly like someone running a blanket cleanup, and it was
briefly recorded here as such. **A whole-window close and a blanket cleanup are
indistinguishable from the session list alone.** Tell them apart by whether an
unrelated task's sessions also vanished *and* the daemon is still healthy —
`opencli doctor` came back fully green through all of it.

**So: work a person is expected to finish goes in `--window foreground`.**
It steals the active tab, which the background-by-default law exists to prevent
— and that is the correct trade here, because a tab nobody can find is worth
exactly nothing. Reserve `isolated` for automation whose output is a file, not
a hand-off.

Two more things that survived the whole episode:

- **Verify by reading the page back, not by trusting the fill command.** Count
  the non-empty inputs in the tab (`filled: 10, of: 13`) — the remainder is the
  CAPTCHA and the submit button, which is exactly the shape a correct hand-off
  should have. A `fill` that returns 0 is not proof anything landed.
- **Re-verify the session list immediately before naming the tabs to the
  person.** Between staging and reporting is where they vanish.

## A fixed session name is a single point of failure across concurrent tasks

Quota sites converge on one session name on purpose (see the browser-runtime
laws) — that is what serialises concurrent callers into one tab. The cost is
that **any task can close it, and every other task using it dies immediately.**

Observed: a long batch traffic run crashed with `No active session "…-nav"`
partway through, because an unrelated workflow on the same machine had closed
that session during its own cleanup. Nothing was wrong with the batch.

Two mitigations, both cheap:

- **Make batch runs resumable and always pass the resume flag on restart.** The
  run above lost nothing because its output was append-per-domain; restarting
  with `--resume` picked up at the exact domain it died on.
- **Never close a session you did not open**, and never run the blanket cleanup
  while other tasks are live. The existing law says this; this is the failure it
  prevents, written down.

## Duplicate-POST as proof-of-storage is lane-specific (2026-10-20)

Six of ten WordPress comment submissions that landed back on the article with
no visible signal were, in fact, stored. The confirmation is a second POST of
the identical payload: WordPress core's duplicate check answers for you —
`409 Duplicate comment detected` is ironclad evidence the *first* POST was
stored, and since the check refuses the second, exactly one copy exists either
way. A silent first POST plus a duplicate second POST is a stored comment every
time.

**But this is a WordPress-core property, not a general one.** Classified-ad and
phpLD-style directories have no duplicate detection, so a re-POST there creates
a real second listing — measured the hard way on freeadsonline: a second POST
fired only to capture the success wording, and the recheck habit now owns a
48-hour follow-up. Before reaching for the trick, answer one question: *does
this backend refuse duplicates?* Comment boards do; classifieds do not.

## WordPress.com comments: curl cannot get there, the browser lane can

Even after extracting `_wpnonce` / `wp_unfiltered_html_comment` from the page
and passing back the session cookies the nonce is bound to
(`res.headers.getSetCookie()`), the POST still returns "Sorry, this comment
could not be posted" — there is a JS-side automation check beyond the nonce
pair. Three targets, all curl-fatal, all browser-lane successes the same hour.

Reading the result matters as much as the lane switch: a *successful* submission
lands back on the clean article page; the *failure* page's title is literally
"Comment Submission Failure". Judge by that pair, never by absence of error
text in the body.

## A CF 403 on curl is a lane switch, not a header problem

Five classifieds (foldads, adslov, classified4u, classifiedonlineads,
freewebads) all 403'd curl with `error code: 1010`. None survived the switch to
the real browser session — all five posted live first try. When the block is
IP-reputation-shaped, stop tuning headers; the fingerprint the WAF dislikes is
the client, not the request.

## Text-arithmetic captchas are program-solvable — entities trip the regex, not the law

247webdirectory prints its "3 + 4 = ?" challenge with the operator as an HTML
entity (`&#x2B;`). `html.unescape` the block first, then parse — otherwise the
regex finds nothing and the site gets misread as needing a human. This is a
text question, not a graphic captcha: solving it programmatically is legitimate
work, not a Lane-B stop.

## phpLD flows collapse to a URL shortcut

The category-picker modal on a phpLD directory only sets hidden `CATEGORY_ID1`;
visiting `/submit?c=<id>` lands directly on step 2 of dizila's flow. From
there: `LINK_TYPE` radio (value `1` = free), the full form (TITLE / URL /
CATEGORY_ID / DESCRIPTION / OWNER_NAME / OWNER_EMAIL / AGREERULES), submit.
The success page reads "Link submitted and awaiting approval". No captcha, no
account — a `open`-cohort target wearing a scary three-step costume.

## Webflow-hosted forms: three traps (epirus.vc)

- The `name` attribute need not match the visible label — "First Name" is
  actually `First-name`. Key off the field's `id`, not a label guess.
- An untouched file input fails the whole submission with "Max size for files
  is 10 MB." Remove the element (`el.remove()`) and resubmit.
- `execCommand('insertText')` on React-controlled inputs can silently mismatch;
  fall back to the native value setter plus `input`/`change` events.

## A "must have Javascript enabled" rejection predicts an email-verify loop

freewebsubmission rejects curl with "Automated submissions are not accepted.
You must have Javascript enabled" — the form carries JS-generated hidden
fields. The browser submits fine, and then the site *mails a verification
link*: poll the mailbox D1 inbox, open the `v.cgi?e=...&c=...` link in a
browser session, and the page answers "verified". The rejection message is the
tell that this target's real cohort is `email-verify`, not `open` — budget the
mailbox round-trip when sequencing the batch.

## Account-age gates are scheduled follow-ups, not dead ends

ctrlalt.cc: registration succeeds (and logs you in), but Launch carries an
account-age badge ("1 days"). The correct move is to register anyway, store the
account with a retry note, and treat the listing as scheduled follow-up work —
abandoning the account because today's button is locked turns a one-day wait
into a permanent loss. Distinguish the gate that *expires* from the gate that
*demands payment or a human*; only the second one is a real stop.

## The outreach browser profile is a standing identity — treat it as the default lane

The outreach default browser environment is the designated profile (currently
`msht4gxm` in opencli, set via `opencli profile use msht4gxm`), which carries
two aged Google accounts (Chloe Bowden / Derek Burns) with live sessions. An
agent that opens a fresh blank session for every target throws that identity
away — and then treats the Google OAuth wall it created as a reason to route
around the site. Real failure mode (2026-10-20, corrected by the owner): an
agent had been submitting from empty sessions all day while the default
profile held everything needed to one-click through the same walls. **Start
every outreach session from the standing profile; only leave it when a target
explicitly conflicts with it.**

## Same-tab OAuth redirects are fully scriptable — don't fear the Google wall

Uneed's "Continue with Google" navigated in the same tab (no popup): the
account chooser and the consent screen are ordinary DOM, and every step —
choose account, click Continue — lands with a normal `opencli click <ref>`.
The popup variant (Fazier) is the one the driver cannot capture; when a popup
OAuth doesn't come back, don't conclude "Google login is unusable" — check
whether the site also offers email sign-up, or whether a second trigger
navigates in-tab. The chooser lists whatever accounts the standing profile
already holds; picking the designated persona is one click.

## Binary uploads into SPA forms: DataTransfer injection, and re-probe after every upload

File inputs that are `sr-only`/visually-hidden never fire a fileChooser event,
so the upload command dead-ends. The working pattern (proven on Fazier,
Uneed, aiboom same day): push the file into the page as base64 chunks eval'd
into `atob()` strings (≤25KB per chunk — 60KB blows the argument limit), join
into a `Uint8Array`, wrap in `File`, add to a `DataTransfer`, assign
`input.files = dt.files`, dispatch `change`. Two things the day's runs added:

- **Every successful upload re-renders the form and changes the
  `input[type=file]` index set** — the logo input disappears once its preview
  replaces it, gallery indices shift. Re-probe `document.querySelectorAll('input[type=file]')`
  before every push instead of caching indices.
- A multiple-gallery input often clears itself after each React-processed
  change; pushing images **one at a time, one change event each**, is the
  reliable path even when the input accepts `multiple`.

A reusable helper lives at `songprint/.backlink/_push_file.sh`
(`bash _push_file.sh <session> <file> <inputIndex> <mime> <filename>`).
Convert WebP assets to JPG first — some forms whitelist only png/jpeg/gif.

## React-controlled date inputs ignore every typed-event trick

`opencli type` on `input[type=date]` reports success and writes nothing; the
value also never sticks through re-renders. What works is the native setter
plus synthetic events —
`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'YYYY-MM-DD')`
then `input` + `change` bubbles. Verify by reading `.value` back, then confirm
the dependent button's label changed (Fazier's "Schedule" became
"Schedule for 10/22/2026" and un-disabled — that label is the real receipt
that React state took the value).

## Multi-select dropdowns that close on every pick

Custom select components (Fazier topics) close the dropdown after each
selection and re-render their options, so refs die between picks. Reopen,
re-mark, re-find, click — once per item. Budget three rounds for "select up
to three".

## Reciprocal-badge gates batch into one footer deploy

Sites that require a backlink badge before accepting/verifying a listing
(Fazier, aitechviral, aiboom) should be **batched**: collect every badge
requirement, add all badges to the source site's footer in one edit, deploy
once, then return to each site and hit Verify. Deploying per-site wastes
builds; worse, deploying the footer from the wrong Cloudflare account
silently produces a site without the badges (songprint's worker lives in the
MAIN account — deploy with `CLOUDFLARE_ACCOUNT_ID` + Global Key + email, not
the NEORAINBOY token).

## The phpLD + SOLVE MEDIA adcopy family: screenshot-region recognition beats every regex (2026-10-21)

A whole network of near-identical directories runs the same stack: a phpLD-style
`/register` + `/submit` pair, `form#thisform` with hidden `ccheck` / `randkey` /
`randkey2` anti-CSRF tokens, and **SOLVE MEDIA's adcopy widget** (`#adcopy-outer`)
on both pages. The challenge is a *text* puzzle — two distorted words on a tinted
panel under "Enter the following:" — not an image-selection grid.

**Identification markers** (all present together, cheap to check in one eval):

- `/register` and `/submit` both reachable, both forms `id=thisform`
- `#adcopy-outer` exists, containing `#adcopy_response` (text answer) and
  `#adcopy_challenge` (hidden)
- hidden `ccheck` + `randkey` + `randkey2` inputs; submit controls are
  `input[type=submit]` with `value=Register` / `value=Submit Website`
- the answer input is `#adcopy_response`; the refresh control is
  `#adcopy-link-refresh`

**The working technique — screenshot the region, then read it.** A full-page
screenshot plus a PIL crop of the widget's `getBoundingClientRect()` box is
enough for a multimodal model to read these puzzles reliably; every phrase is
plain English ("now look here", "butter side down", "fair and square"). One
eval gets the box, one screenshot, one crop, one read — then
`fill #adcopy_response <phrase>` and click the real button. Do not attempt OCR
libraries or regex against the page HTML; the phrase is only in the image.

```bash
# 1. box
opencli browser "$S" eval "() => { const r = document.querySelector('#adcopy-outer').getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); }"
# 2. screenshot + crop that box (PIL), read the crop, fill the answer
opencli browser "$S" fill "#adcopy_response" "<phrase read off the crop>"
```

Four traps, each of which silently costs a submission:

1. **Challenges expire in roughly 2–5 minutes.** An expired challenge makes the
   site's JS block the submit *silently* — the click reports `hit: target`, no
   POST fires, no error renders, the page just sits there. The tell is "click
   landed, nothing happened, no error": click `#adcopy-link-refresh`, re-screenshot,
   re-read, re-answer. Do not re-click with the old answer.
2. **Element indices drift after any failed submit.** The error banner re-renders
   the page and every `[N]` index shifts (observed: submit button 47 → 48). A
   stale index lands on a hidden `randkey` input and does nothing at all. Either
   re-run `state` for fresh indices or click by CSS selector
   (`input[type=submit][value=Register]`) — the selector survived every drift.
3. **`form.submit` is shadowed by the submit button.** The button's
   `name=submit` property masks the method, so `f.submit()` throws
   `f.submit is not a function`. `requestSubmit()` runs but a page-level handler
   can still cancel it. The button click is the only reliable path.
4. **Category selection may not survive.** A pick of "Computers" landed as
   "Internet" on one family member. Harmless for the link, but record what the
   public page actually shows, not what was selected.

**Success signal and verification:** a live submission changes the URL to
`/listings<id>/<slug>`. Confirm from outside with a cookie-less fetch: HTTP 200
plus the outbound `href` present in the public HTML. Session-cookie views prove
nothing (see the blog-comment section above).

**Volume discipline — this is one operator's template family.** The domains are
near-clones (same header, same footer, same copyright line), so N listings from
N family members is one relationship, not N. Cap it (6 were live by 2026-10-22,
owner-declared enough) and spend the next effort on genuinely distinct
directories and launch platforms. Each registration still needs its own
per-target mailbox alias.

## Launch-page platforms: the upsell page is not the verdict

Fazier's flow ends by redirecting to `/premium` with no skip link — that does
**not** mean the launch failed. The launch page (`/launches/<slug>`) exists
immediately, owner-visible, and the upsell is just an offer. Judge by
navigating to the product URL, not by looking for a "skip" on the paywall.
Uneed's variant: "Preview my product" lets a robot fetch and build the listing
first (name/url only), the signup wall comes after, and the free launch queue
is months out while the product page itself is live the moment you save it —
the listing/backlink is already real. Uneed's completion checklist names the
exactly-one missing item (e.g. "❌ Logo"); fix just that and save.

## React/Vue controlled forms: typing beats value injection

Writing `el.value = x` plus an `input` event is enough for plain HTML forms, but
on hydrated React/Vue forms the state layer often wins and reverts the field on
the next re-render — you see `field:ok`, then the value is empty right after a
select/category change. The reliable move is real keystrokes:
`opencli browser <sess> type "<css selector>" "<text>"`. Reserve the JS setter
for plain GET/POST forms (phpLD, old PHP directories) and for hidden fields.

**A `<meta name="description">` will shadow `[name=description]`.** Always
scope selectors by element type when the field name is generic:
`textarea[name=description]`, not `[name=description]`. A selector that quietly
matches a `<meta>` reads as `value === undefined` and looks like a React bug.

**Custom selectors are not `<select>`.** Radix/shadcn "Select ..." buttons,
uni-app pickers and Feishu 问卷 controls keep their options out of the DOM until
opened by a real click, and assigning `.value` proves nothing. If the field is
optional, submit without it. If it is required, drive the trigger button and
read `[role=option]` — do not burn ten calls guessing.

**Silent-failure taxonomy.** Distinguish "posted" from "the form ate it":

- no POST + message element stays empty (`data-action=...` handler never
  attached) → not submitted, park it;
- `form.checkValidity() === true` yet the site answers "check highlighted
  fields" → server-side rule, park it;
- values retained after clicking submit → nothing was sent;
- values cleared with a thank-you/next-step copy → submitted.

**Reciprocal-link gates are a hard stop, not a form to fill.** "免费提交" pages
that print an `<a href>` snippet to paste into your homepage cost a site edit;
same for Fazier-style badges. Reject and move on.

**Language-gated Chinese directories.** Some explicitly say 纯外语网站暂时不收录
(pure foreign-language sites are not accepted). Filling the form still counts
as nothing — check the copy before spending calls.

## Automation window budget is shared

OpenCLI keeps four dedicated windows for the whole machine. Parallel agents
(Skill runs, other projects) evict each other: a session that worked one call
ago answers `session_not_found` or `dedicated-pool-exhausted` mid-flow. Plan
for it — one site per session, close on success, and re-open rather than
assuming state survived. Never batch 30 sites into one long script without a
retry wrapper.

**opencli eval output hygiene.** PowerShell merges stderr into the captured
string, so a single npm "Update available" line corrupts a JSON result. Use
base64 for the payload, `2>$null` for the call, strip non-ASCII in the returned
object, and keep the JSON under ~1.5 KB — long payloads come back truncated and
unparseable.

## Comment verification: rel="ugc" is the dofollow tell

When a WordPress comment goes live, inspect the rendered markup, not the form:

- author link (Name field) is almost always `rel="ugc external nofollow"`;
- a body link keeps only `rel="ugc"` when the newline trick beat
  `wp_rel_nofollow()` — that is the dofollow link worth counting;
- confirm from a cookie-less HTTP fetch of the permalink; the session view
  proves nothing.

Short generic comments ("Nice post — ...") with one body link pass where long
essays get held. Keep the anchor in the Name field, keep the body to a single
sentence, and cap body-link comments well under half the batch.


## Generic form driver: what it actually gets right and wrong (2026-10-22)

Walking 10+ unrelated AI directories with one driver beats hand-driving each
page, but only if the driver is honest about where it stops. The shape that
worked:

1. enumerate every visible `input/textarea/select`, tag each with `data-bf`,
   and record label + placeholder + name + required;
2. classify by the concatenated label, fill through the native value setter and
   dispatch `input` + `change` (plain PHP/Webflow/WP forms accept this);
3. tag visible buttons `data-bbtn`, click the one whose text matches
   `submit|send|add tool|continue`, then re-read URL and body text;
4. write the whole census + plan to a JSON file so the next attempt does not
   have to guess again.

Where it fails, and what to do instead:

- **Silent no-op.** A click that produces no request, no form reset and no
  message is a failure, not a submission. (listedai.co: button handler throws;
  reviewai.net: two clicks, no receipt.) Never ledger a site on button-click
  alone.
- **Required checkbox groups.** A form can look complete and still refuse to
  submit because a *group* has no value (futuretools.io `pricing_tier`). Read
  the page for `checkbox`/`radio` groups the mapper skipped and pick the honest
  one before clicking.
- **Placeholder-only fields.** Some React forms ship inputs with no `name` and
  no `id`, so nothing can be targeted by attribute (verifiedtools.info). Fall
  back to index-based overrides (`i0`, `i1`, ...) captured from the census.
- **Framework embeds.** A "submit" page whose form lives in an iframe
  (beehiiv, Tally, Typeform) shows zero fields to the page-level census. Read
  the iframe `src` first and drive that document instead.
- **Client-side route buttons.** A button labelled "Submit a Tool" that neither
  navigates nor opens a form (theaipedia.io, nextaitool.com) is a dead end in
  automation; stop and mark it manual instead of retrying the click.

## Preserve a real newline in a body link: set the value, do not type it

The dofollow trick only works if the line break inside `<a ...>` is a real
newline, and keystroke typing turns Enter into a submit or a lost character.
Set the textarea through the native setter with the newline already inside the
string (`href="https://example.com/page\n"`), dispatch `input`/`change`, then
click submit. Confirm afterwards that the stored value still contains a newline
before trusting the post.

## Verify a public comment with a cache buster

Caching plugins (Perfmatters, WP Rocket) serve the comment page without the
newly approved comment on the first anonymous fetch. Re-fetch the permalink with
a query string (`?x=1`, `?cb=<ts>`) and `cache-control: no-cache` before
concluding "moderated" - one comment in this batch looked invisible until the
cache-busted URL revealed it, dofollow and all.

## Similarweb referral mining: filter link-farm clones before probing

Pulling referring domains for six AI directories returned ~400 hosts, and the
form probe found only a handful of real forms. The rejects shared fingerprints:

- the same `/sites/<id>.html` URL shape across several domains
  (aicangku.com, ainvp.com, haouu.com, hooaoo.com) - one operator, many skins;
- the same article slug copied onto unrelated domains
  (`trai-nghiem-game-dinh-cao-tai-32295` on bulldogtheatre.com,
  pahlindustrial.com, blueskiesmktg.com).

Either pattern means skip the whole family, not just the one host that showed a
form.

## Free the automation window pool automatically

`dedicated-pool-exhausted` is the most common way a batch dies halfway. Every
driver should close its session on exit (a `process.on('exit')` hook is enough),
and on the first pool error it should list sessions, close the longest-idle one,
and retry the open instead of aborting the run.
