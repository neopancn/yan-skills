import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

const exec = promisify(execFile);
const script = new URL("../scripts/indexnow-submit.mjs", import.meta.url).pathname;
const day = (offset) => new Date(Date.parse(new Date().toISOString().slice(0, 10)) + offset * 86400000).toISOString().slice(0, 10);
const row = (path, date) => `<url><loc>https://example.com/${path}</loc>${date === undefined ? "" : `<lastmod>${date}</lastmod>`}</url>`;
const xml = `<urlset>${row("recent", day(0))}${row("boundary", day(-2))}${row("old", day(-3))}${row("undated")}</urlset>`;
const run = async (sitemap, ...args) => (await exec(process.execPath, [script, "--dry-run", "--site-url", "https://example.com", "--key", "0".repeat(32), "--sitemap", sitemap, ...args])).stdout;
const urls = (output) => [...output.matchAll(/^\s+\[\d+\] (.+)$/gm)].map((m) => m[1]);

test("lastmod 窗口只用本地 sitemap，包含边界和无日期，不依赖状态", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "indexnow-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "pages.xml");
  await writeFile(file, xml);
  await t.test("--days 2 与 --since 包含 UTC 起点，重复执行一致", async () => {
    const expected = ["recent", "boundary", "undated"].map((p) => `https://example.com/${p}`);
    assert.deepEqual(urls(await run(file, "--days", "2")), expected);
    assert.deepEqual(urls(await run(file, "--since", day(-2))), expected);
    assert.deepEqual(urls(await run(file, "--days", "2")), expected);
  });
  await t.test("无窗口参数仍全量；--all 覆盖窗口", async () => {
    const expected = ["recent", "boundary", "old", "undated"].map((p) => `https://example.com/${p}`);
    assert.deepEqual(urls(await run(file)), expected);
    assert.deepEqual(urls(await run(file, "--days", "2", "--all")), expected);
  });
  await t.test("递归索引读子 sitemap 的页面日期，去重，不推 XML", async () => {
    const index = join(dir, "index.xml");
    await writeFile(index, '<sitemapindex><sitemap><loc>pages.xml</loc><lastmod>2000-01-01</lastmod></sitemap><sitemap><loc>nested.xml</loc></sitemap></sitemapindex>');
    await writeFile(join(dir, "nested.xml"), '<sitemapindex><sitemap><loc>pages.xml</loc></sitemap></sitemapindex>');
    assert.deepEqual(urls(await run(index, "--days", "2")), ["recent", "boundary", "undated"].map((p) => `https://example.com/${p}`));
    assert.equal(urls(await run(index, "--all")).length, 4);
  });
  await t.test("无变化 exit 0，空窗口不提交；非法日期保守包含", async () => {
    const old = join(dir, "old.xml");
    await writeFile(old, `<urlset>${row("old", day(-3))}</urlset>`);
    assert.match(await run(old, "--days", "2"), /没有近期变动 URL/);
    await writeFile(old, `<urlset>${row("invalid", "invalid")}${row("timestamp", `${day(-2)}T00:00:00Z`)}</urlset>`);
    assert.equal(urls(await run(old, "--days", "2")).length, 2);
  });
  await t.test("HTTP sitemap 与旧默认全量、显式路径兼容，服务只读", async () => {
    const server = createServer((req, res) => {
      assert.equal(req.method, "GET");
      res.end(xml);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = `http://127.0.0.1:${server.address().port}/sitemap.xml`;
      assert.equal(urls(await run(address)).length, 4);
      assert.equal(urls(await run(address, "--days", "2")).length, 3);
      assert.deepEqual(urls(await run(address, "/explicit", "--days", "2")), ["https://example.com/explicit"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
