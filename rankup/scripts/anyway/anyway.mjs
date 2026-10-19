#!/usr/bin/env node
// 用途：只读查询 Merchant API 并验签 webhook。参数：--env stg|prod、--env-file <路径> 与 help 所列命令。
// 登录态：无需浏览器登录，需对应 API key；已知坑：stg/prod key 不通用。验证日期：2026-09-07（原流程）。
// Usage: node rankup/scripts/anyway/anyway.mjs [--env prod|stg] <command> [subcommand] [--flags]
// Run `node rankup/scripts/anyway/anyway.mjs help` for full usage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiGet, ApiError, setActiveEnv, setEnvFile } from './lib/client.mjs';
import { fetchSigningKeys, importVerificationKeys, verifyWebhookSignature } from './lib/webhook.mjs';
import { resolveEnvName, getEnvConfig } from './lib/env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');

function jwksCachePath(envName) {
  return path.join(CACHE_DIR, `jwks-${envName}.json`);
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        const key = tok.slice(2, eq);
        flags[key] = tok.slice(eq + 1);
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { flags, positional };
}

/**
 * Pull a global `--name value` (or `--name=value`) flag out of argv from
 * anywhere in the array — so `--env stg` works whether it's typed before or
 * after the command (e.g. `anyway.mjs --env stg me` or `anyway.mjs me --env stg`).
 * @returns {{ value: string|undefined, rest: string[] }}
 */
function extractGlobalFlag(argv, name) {
  const prefix = `--${name}`;
  const idx = argv.findIndex((t) => t === prefix || t.startsWith(`${prefix}=`));
  if (idx === -1) return { value: undefined, rest: argv };
  const tok = argv[idx];
  const eq = tok.indexOf('=');
  if (eq !== -1) {
    return { value: tok.slice(eq + 1), rest: [...argv.slice(0, idx), ...argv.slice(idx + 1)] };
  }
  const value = argv[idx + 1];
  const consumesNext = value !== undefined && !value.startsWith('--');
  const rest = consumesNext
    ? [...argv.slice(0, idx), ...argv.slice(idx + 2)]
    : [...argv.slice(0, idx), ...argv.slice(idx + 1)];
  return { value: consumesNext ? value : undefined, rest };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

/** Print an array of plain objects as a simple aligned table. */
function printTable(rows, columns) {
  if (!rows || rows.length === 0) {
    console.log('(no records)');
    return;
  }
  const cols = columns ?? Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length))
  );
  const header = cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(header);
  console.log(cols.map((_, i) => '-'.repeat(widths[i])).join('  '));
  for (const row of rows) {
    console.log(cols.map((c, i) => String(row[c] ?? '').padEnd(widths[i])).join('  '));
  }
}

function printKv(obj) {
  const width = Math.max(...Object.keys(obj).map((k) => k.length));
  for (const [k, v] of Object.entries(obj)) {
    let display;
    if (v === null || v === undefined) display = '';
    else if (Array.isArray(v) || typeof v === 'object') display = JSON.stringify(v);
    else display = String(v);
    console.log(`${k.padEnd(width)} : ${display}`);
  }
}

// ---------------------------------------------------------------------------
// pagination helper
// ---------------------------------------------------------------------------

/**
 * Fetch a paginated endpoint, optionally following every page (`--all`).
 * @returns {Promise<{records: any[], page: number, pages: number, total: number, size: number}>}
 */
async function fetchPaginated(pathname, query, { all }) {
  const size = Number(query.size ?? 20);
  let page = Number(query.page ?? 1);
  const records = [];
  let last;
  do {
    const data = await apiGet(pathname, { ...query, page, size });
    last = data;
    records.push(...(data.records ?? []));
    page = (data.page ?? page) + 1;
  } while (all && last && last.page < last.pages);
  return { ...last, records };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdMe() {
  const data = await apiGet('/v1/me');
  return data;
}

async function cmdOrdersList(flags) {
  const query = {
    page: flags.page,
    size: flags.size,
    status: flags.status,
    product_id: flags.product,
    customer_id: flags.customer,
    subscription_id: flags.subscription,
    provider: flags.provider,
    from_address: flags['from-address'],
    merchant_reference: flags['merchant-ref'],
    date_from: flags.from,
    date_to: flags.to,
  };
  return fetchPaginated('/v1/orders', query, { all: !!flags.all });
}

async function cmdOrdersGet(id) {
  return apiGet(`/v1/orders/${encodeURIComponent(id)}`);
}

async function cmdProductsList(flags) {
  const query = { page: flags.page, size: flags.size, status: flags.status, search: flags.search };
  return fetchPaginated('/v1/products', query, { all: !!flags.all });
}

async function cmdProductsGet(id) {
  return apiGet(`/v1/products/${encodeURIComponent(id)}`);
}

async function cmdProductsLinks(id) {
  return apiGet(`/v1/products/${encodeURIComponent(id)}/payment-links`);
}

async function cmdSubscriptionsList(flags) {
  const query = { page: flags.page, size: flags.size, status: flags.status, customer_id: flags.customer };
  return fetchPaginated('/v1/subscriptions', query, { all: !!flags.all });
}

async function cmdSubscriptionsGet(id) {
  return apiGet(`/v1/subscriptions/${encodeURIComponent(id)}`);
}

async function cmdCustomersList(flags) {
  const query = { page: flags.page, size: flags.size };
  return fetchPaginated('/v1/customers', query, { all: !!flags.all });
}

async function cmdCustomersGet(id) {
  return apiGet(`/v1/customers/${encodeURIComponent(id)}`);
}

async function cmdEntitlementsCheck(flags) {
  const query = {
    email: flags.email,
    wallet: flags.wallet,
    customer_id: flags.customer,
    product_id: flags.product,
    refresh: flags.refresh,
  };
  return apiGet('/v1/entitlements/check', query);
}

async function cmdRaw(pathname, flags, positional) {
  const query = {};
  for (const q of positional) {
    const eq = q.indexOf('=');
    if (eq === -1) continue;
    query[q.slice(0, eq)] = q.slice(eq + 1);
  }
  return apiGet(pathname, query);
}

// ---------------------------------------------------------------------------
// webhook verify
// ---------------------------------------------------------------------------

async function loadJwksWithCache(envName, jwksUrl, { forceRefresh } = {}) {
  const cachePath = jwksCachePath(envName);
  if (!forceRefresh && fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      // fall through to refetch
    }
  }
  const jwks = await fetchSigningKeys(fetch, jwksUrl);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(jwks, null, 2));
  return jwks;
}

async function cmdWebhookVerify(flags, envName) {
  const { id, timestamp, signature } = flags;
  const bodyFile = flags['body-file'];
  if (!id || !timestamp || !signature || !bodyFile) {
    throw new Error('webhook verify requires --id --timestamp --signature --body-file');
  }

  const jwksUrl = flags['jwks-url'] || getEnvConfig(envName).jwksUrl;
  if (!jwksUrl) {
    throw new Error(
      `No JWKS URL configured for env "${envName}". Pass --jwks-url <url>.`
    );
  }

  const rawBody = fs.readFileSync(bodyFile);

  let jwks = await loadJwksWithCache(envName, jwksUrl, { forceRefresh: false });
  let keys = await importVerificationKeys(jwks);
  let result = await verifyWebhookSignature({
    id,
    timestamp,
    signatureHeader: signature,
    rawBody: new Uint8Array(rawBody),
    keys,
  });

  if (!result.ok) {
    // signature could be genuinely invalid, or our cached key rotated out — refresh once and retry.
    jwks = await loadJwksWithCache(envName, jwksUrl, { forceRefresh: true });
    keys = await importVerificationKeys(jwks);
    result = await verifyWebhookSignature({
      id,
      timestamp,
      signatureHeader: signature,
      rawBody: new Uint8Array(rawBody),
      keys,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// output rendering per-command
// ---------------------------------------------------------------------------

function renderOrders(result, asJson) {
  if (asJson) return printJson(result);
  const rows = result.records.map((o) => ({
    orderId: o.orderId,
    status: o.status,
    displayStatus: o.displayStatus,
    amount: o.amount,
    currency: o.currency,
    productName: o.productName,
    customerEmail: o.customerEmail,
    createdAt: o.createdAt,
  }));
  printTable(rows);
  console.log(`\npage ${result.page}/${result.pages}  total=${result.total}  size=${result.size}`);
}

function renderProducts(result, asJson) {
  if (asJson) return printJson(result);
  const rows = result.records.map((p) => ({
    productId: p.productId,
    name: p.name,
    status: p.status,
    paymentLinks: (p.paymentLinks ?? []).length,
    updatedAt: p.updatedAt,
  }));
  printTable(rows);
  console.log(`\npage ${result.page}/${result.pages}  total=${result.total}  size=${result.size}`);
}

function renderSubscriptions(result, asJson) {
  if (asJson) return printJson(result);
  const rows = result.records.map((s) => ({
    subscriptionId: s.subscriptionId,
    status: s.status,
    productName: s.productName,
    customerEmail: s.customerEmail,
    amountCents: s.amountCents,
    currency: s.currency,
    billingInterval: s.billingInterval,
    currentPeriodEnd: s.currentPeriodEnd,
  }));
  printTable(rows);
  console.log(`\npage ${result.page}/${result.pages}  total=${result.total}  size=${result.size}`);
}

function renderCustomers(result, asJson) {
  if (asJson) return printJson(result);
  const rows = result.records.map((c) => ({ customerId: c.customerId, email: c.email }));
  printTable(rows);
  console.log(`\npage ${result.page}/${result.pages}  total=${result.total}  size=${result.size}`);
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

const HELP = `anyway-merchant — CLI for the Anyway Business Merchant API (read-only)

Usage:
  node rankup/scripts/anyway/anyway.mjs [--env prod|stg] <command> [args] [--flags]

Environment:
  --env stg|prod       > ANYWAY_ENV env var > default "stg"
  --env-file <path>    project-side .env, after environment and rankup/.env
  ANYWAY_API_BASE       overrides the resolved base URL directly

Auth:
  prod: ANYWAY_API_KEY env var, then rankup/.env, then --env-file
  stg:  ANYWAY_STG_API_KEY env var, then rankup/.env, then --env-file

Commands:
  me
  orders list [--status] [--product] [--customer] [--subscription] [--provider]
              [--merchant-ref] [--from-address] [--from] [--to] [--page] [--size] [--all]
  orders get <id>
  products list [--status] [--search] [--page] [--size] [--all]
  products get <id>
  products links <id>
  subscriptions list [--status] [--customer] [--page] [--size] [--all]
  subscriptions get <id>
  customers list [--page] [--size] [--all]
  customers get <id>
  entitlements check [--email] [--wallet] [--customer] [--product] [--refresh true|false]
  raw <path> [k=v ...]         # arbitrary GET, e.g. raw /v1/me
  webhook verify --id <id> --timestamp <ts> --signature <sig-header> --body-file <path>
                 [--jwks-url <url>]  # optional override

Global flags:
  --json     print raw API JSON instead of a table (readable-mode output starts with "[env: ...]")
  --all      (list commands) auto-paginate and fetch every page

Notes:
  Merchant API is read-only. Products, payment links, webhooks and refunds are
  configured in the merchant dashboard (app.anyway.sh for prod, stg.anyway.sh for stg),
  not through this CLI.
`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const rawArgv = process.argv.slice(2);
  const { value: envFlagValue, rest: withEnvFile } = extractGlobalFlag(rawArgv, 'env');
  const { value: envFile, rest: argv } = extractGlobalFlag(withEnvFile, 'env-file');
  setEnvFile(envFile);

  let envName;
  try {
    envName = resolveEnvName(envFlagValue);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  setActiveEnv(envName);

  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return;
  }

  const [command, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  const asJson = !!flags.json;

  if (!asJson) {
    console.log(`[env: ${envName}]`);
  }

  try {
    switch (command) {
      case 'me': {
        const data = await cmdMe();
        if (asJson) printJson(data);
        else printKv(data);
        break;
      }

      case 'orders': {
        const sub = positional[0];
        if (sub === 'list') {
          const result = await cmdOrdersList(flags);
          renderOrders(result, asJson);
        } else if (sub === 'get') {
          const id = positional[1];
          if (!id) throw new Error('usage: orders get <id>');
          const data = await cmdOrdersGet(id);
          if (asJson) printJson(data);
          else printKv(data);
        } else {
          throw new Error('usage: orders <list|get> ...');
        }
        break;
      }

      case 'products': {
        const sub = positional[0];
        if (sub === 'list') {
          const result = await cmdProductsList(flags);
          renderProducts(result, asJson);
        } else if (sub === 'get') {
          const id = positional[1];
          if (!id) throw new Error('usage: products get <id>');
          const data = await cmdProductsGet(id);
          if (asJson) printJson(data);
          else printKv(data);
        } else if (sub === 'links') {
          const id = positional[1];
          if (!id) throw new Error('usage: products links <id>');
          const data = await cmdProductsLinks(id);
          if (asJson) printJson(data);
          else {
            // API 的 paymentLinkUrl 恒为空；支付页 prod 在 app.anyway.sh，stg 在 stg.anyway.sh（anyway.sh/pay/* 是 404）。
            // 用 linkId 拼出真实地址，并实际请求一次，页面 404 或标题含 "Page not found" 就标 FAIL。
            const base = getEnvConfig(envName).dashboardUrl.replace(/\/$/, '');
            const rows = [];
            for (const l of data ?? []) {
              const payUrl = l.linkId ? `${base}/pay/${l.linkId}` : '';
              let check = '';
              if (payUrl) {
                try {
                  const r = await fetch(payUrl);
                  const html = r.ok ? await r.text() : '';
                  check = r.ok && !/Page not found/i.test(html) ? `OK ${r.status}` : `FAIL ${r.status}`;
                } catch (e) {
                  check = `FAIL ${e.message}`;
                }
              }
              rows.push({
                name: l.name,
                pricingType: l.pricingType,
                amount: l.amount,
                currency: l.currency,
                isActive: l.isActive,
                payUrl,
                check,
              });
            }
            printTable(rows);
          }
        } else {
          throw new Error('usage: products <list|get|links> ...');
        }
        break;
      }

      case 'subscriptions': {
        const sub = positional[0];
        if (sub === 'list') {
          const result = await cmdSubscriptionsList(flags);
          renderSubscriptions(result, asJson);
        } else if (sub === 'get') {
          const id = positional[1];
          if (!id) throw new Error('usage: subscriptions get <id>');
          const data = await cmdSubscriptionsGet(id);
          if (asJson) printJson(data);
          else printKv(data);
        } else {
          throw new Error('usage: subscriptions <list|get> ...');
        }
        break;
      }

      case 'customers': {
        const sub = positional[0];
        if (sub === 'list') {
          const result = await cmdCustomersList(flags);
          renderCustomers(result, asJson);
        } else if (sub === 'get') {
          const id = positional[1];
          if (!id) throw new Error('usage: customers get <id>');
          const data = await cmdCustomersGet(id);
          if (asJson) printJson(data);
          else printKv(data);
        } else {
          throw new Error('usage: customers <list|get> ...');
        }
        break;
      }

      case 'entitlements': {
        const sub = positional[0];
        if (sub === 'check') {
          const data = await cmdEntitlementsCheck(flags);
          if (asJson) printJson(data);
          else printKv(data);
        } else {
          throw new Error('usage: entitlements check ...');
        }
        break;
      }

      case 'raw': {
        const p = positional[0];
        if (!p) throw new Error('usage: raw <path> [k=v ...]');
        const data = await cmdRaw(p, flags, positional.slice(1));
        printJson(data);
        break;
      }

      case 'webhook': {
        const sub = positional[0];
        if (sub === 'verify') {
          const result = await cmdWebhookVerify(flags, envName);
          if (result.ok) {
            console.log('OK: signature valid');
          } else {
            console.log(`FAIL: ${result.reason}`);
            process.exitCode = 1;
          }
        } else {
          throw new Error('usage: webhook verify --id --timestamp --signature --body-file');
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(err.message);
      if (err.body && typeof err.body === 'object') {
        console.error(JSON.stringify(err.body, null, 2));
      }
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exitCode = process.exitCode || 1;
  }
}

main();
