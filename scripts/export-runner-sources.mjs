#!/usr/bin/env node
/* eslint-disable */
// 订阅爬虫源导出助手：从合并后的订阅配置中筛选可运行的 catjs 单源猫包，
// 下载脚本、计算 SHA256 指纹，生成源运行网关（runners/）的配置片段。
//
// 用法：
//   node scripts/export-runner-sources.mjs --config <合并后的ConfigFile.json> --out <输出目录>
//   node scripts/export-runner-sources.mjs --url <订阅地址> --out <输出目录>
//
// 说明：
// - 仅导出 protocol=catjs 且 api 为 http(s) 单源脚本的站点；
// - 同一 api 被多个站点引用（drpy 等多合一运行时）会被跳过并提示——
//   此类源需要专属宿主（QuickJS/drpy 契约），cat-host 无法直接运行；
// - csp_*（jar/DEX）源需要 Android 桥，不在本脚本范围；
// - 生成的配置片段仍需人工审查后合并进 runner 的 config.json，
//   本脚本只做"下载 + 指纹固定"，不代替审查。

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const configPath = getArg('config');
const subscriptionUrl = getArg('url');
const outDir = getArg('out');

if ((!configPath && !subscriptionUrl) || !outDir) {
  console.error(
    '用法: node scripts/export-runner-sources.mjs --config <ConfigFile.json> | --url <订阅地址> --out <输出目录>'
  );
  process.exit(1);
}

const scriptLimit = 8 * 1024 * 1024;
const timeoutMs = 30_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

let configContent;

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
    cache: 'no-store',
    headers: { 'User-Agent': UA },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 5 * 1024 * 1024) throw new Error('内容超过 5MB');
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

// 与应用端 config-subscription.ts 一致的最小归一化：sites 数组 → api_site，
// 协议推断（catjs/csp/cms）+ 相对地址解析
function resolveResource(value, baseUrl) {
  if (
    !baseUrl ||
    (/^csp_|^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:/i.test(value)) ||
    !/^(?:https?:\/\/|\/|\.\/|\.\.\/)|\.(?:m?js|jar|json|txt)(?:[?;#]|$)/i.test(value)
  ) {
    return value;
  }
  const [resource, ...suffix] = value.split(';');
  try {
    return [new URL(resource, baseUrl).href, ...suffix].join(';');
  } catch {
    return value;
  }
}

function normalizeTvBoxConfig(config, baseUrl) {
  if (Array.isArray(config.sites)) {
    const apiSite = {};
    for (const site of config.sites) {
      if (!site || typeof site.key !== 'string' || !site.key.trim()) continue;
      const api = typeof site.api === 'string' ? site.api : '';
      apiSite[site.key] = {
        ...site,
        protocol:
          site.protocol ??
          (/\.m?js(?:[?;#]|$)|;md5;/i.test(api) && !/\.jar(?:[?;#]|$)/i.test(api)
            ? 'catjs'
            : /^csp_/i.test(api) || site.type === 3
            ? 'csp'
            : 'cms'),
        siteType: site.siteType ?? site.type,
        spider: site.spider ?? config.spider,
        ...(api ? {} : { api: '' }),
      };
    }
    config = { ...config, api_site: apiSite };
  }
  const apiSite = config.api_site || {};
  for (const [key, site] of Object.entries(apiSite)) {
    if (typeof site?.api === 'string') {
      site.api = resolveResource(site.api, baseUrl);
    }
    if (typeof site?.spider === 'string') {
      site.spider = resolveResource(site.spider, baseUrl);
    }
    if (site?.ext && typeof site.ext === 'string') {
      site.ext = resolveResource(site.ext, baseUrl);
    }
  }
  return config;
}

let baseSubscriptionUrl;

async function loadConfig() {
  if (configPath) {
    return normalizeTvBoxConfig(
      JSON.parse(await readFile(configPath, 'utf-8')),
      undefined
    );
  }
  const text = await fetchText(subscriptionUrl);
  // 订阅内容可能是 Base58 编码（与应用端 parseConfigSubscription 一致）
  let decoded = text.trim();
  if (!decoded.startsWith('{') && !decoded.startsWith('[')) {
    const ALPHABET =
      '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const bytes = [];
    for (const char of decoded) {
      let value = ALPHABET.indexOf(char);
      if (value < 0) throw new Error('订阅内容既非 JSON 也非 Base58');
      for (let i = 0; i < bytes.length; ++i) {
        value += bytes[i] * 58;
        bytes[i] = value & 0xff;
        value >>= 8;
      }
      while (value > 0) {
        bytes.push(value & 0xff);
        value >>= 8;
      }
    }
    for (let i = 0; i < decoded.length - 1; ++i) bytes.push(0);
    decoded = new TextDecoder('utf-8', { fatal: false }).decode(
      Buffer.from(bytes.reverse())
    );
  }
  const parsed = JSON.parse(decoded);
  let baseUrl;
  try {
    baseUrl = new URL(subscriptionUrl).href;
  } catch {
    baseUrl = undefined;
  }
  return normalizeTvBoxConfig(parsed, baseUrl);
}

function apiScriptUrl(api) {
  const [resource] = String(api).split(';');
  try {
    const url = new URL(resource);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!/\.(m?js|cjs)(\?|#|$)/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

const config = await loadConfig();
const apiSite = config.api_site || {};
const entries = Object.entries(apiSite);

// 统计各 api 被多少站点共用：共用 > 1 视为多合一运行时（如 drpy2.min.js）
const apiUsage = new Map();
for (const [, site] of entries) {
  const url = apiScriptUrl(site.api || '');
  if (!url) continue;
  apiUsage.set(url, (apiUsage.get(url) || 0) + 1);
}

const candidates = [];
const skipped = [];
for (const [key, site] of entries) {
  if (site.protocol !== 'catjs') {
    if (site.protocol === 'csp') {
      skipped.push(`${key}: csp 源需要 Android 桥（CSP_BRIDGE），不在导出范围`);
    } else if (site.runtimeStatus === 'unsupported') {
      skipped.push(`${key}: 类型 ${site.siteType} 标记为不支持`);
    }
    continue;
  }
  const url = apiScriptUrl(site.api || '');
  if (!url) {
    skipped.push(`${key}: api 不是可下载的 http(s) JS 脚本`);
    continue;
  }
  if (apiUsage.get(url) > 1) {
    skipped.push(
      `${key}: api 脚本被多个站点共用（多合一运行时，如 drpy），cat-host 无法直接运行`
    );
    continue;
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) {
    skipped.push(`${key}: key 含 runner 不接受的字符`);
    continue;
  }
  candidates.push({ key, site, url });
}

console.log(
  `订阅共 ${entries.length} 个站点：可导出 ${candidates.length} 个，跳过 ${skipped.length} 个`
);
if (skipped.length > 0) console.log(skipped.map((s) => `  - ${s}`).join('\n'));
if (candidates.length === 0) {
  console.log('没有可导出的 catjs 单源猫包，结束。');
  process.exit(0);
}

const sourcesDir = resolve(outDir, 'sources');
await mkdir(sourcesDir, { recursive: true });

const runtimes = {};
const sites = [];

for (const { key, site, url } of candidates) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      cache: 'no-store',
      headers: { 'User-Agent': UA },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > scriptLimit) {
      throw new Error('脚本为空或超过 8MB');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const fileName = `${key}.cjs`;
    await writeFile(resolve(sourcesDir, fileName), bytes);
    const runtimeId = `remote-${key}`;
    runtimes[runtimeId] = {
      scriptPath: `sources/${fileName}`,
      sha256,
      scriptUrl: url,
      workDirectory: `data/${runtimeId}`,
      config: { color: [] },
    };
    sites.push({
      key,
      kind: 'catjs',
      runtime: runtimeId,
      upstreamKey: key,
      init: {
        siteKey: key,
        type: 3,
        api: String(site.api).split(';')[0],
        ext: site.ext ?? {},
      },
    });
    console.log(`  + ${key}: ${url} -> sources/${fileName} (sha256 ${sha256})`);
  } catch (error) {
    console.log(`  ! ${key}: 下载失败（${error.message}），已跳过`);
  }
}

if (sites.length === 0) {
  console.log('全部候选下载失败，未生成配置。');
  process.exit(1);
}

const outputPath = resolve(outDir, 'runner-config.fragment.json');
await writeFile(
  outputPath,
  JSON.stringify({ runtimes, sites }, null, 2),
  'utf-8'
);

console.log('');
console.log(`已生成 ${sites.length} 个源配置片段：${outputPath}`);
console.log('后续步骤：');
console.log('  1. 人工审查 sources/*.cjs（本脚本不代替审查）；');
console.log('  2. 将片段中的 runtimes/sites 合并进 runner 的 config.json；');
console.log('  3. 应用端设置 SOURCE_RUNNER_URL / SOURCE_RUNNER_TOKEN 后重启。');
