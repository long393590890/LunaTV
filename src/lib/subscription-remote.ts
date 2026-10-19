/* eslint-disable no-console */

import {
  extractStoreHouseUrls,
  mergeNormalizedConfigs,
  parseConfigSubscription,
} from './config-subscription';

// 批量订阅拉取：多个订阅地址 + 多仓（storeHouse）一层展开，逐地址容错合并。
// 单个订阅失败只记录错误，不阻断其余订阅。

const MAX_SUBSCRIPTION_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_CONCURRENCY = 4;
const MAX_STOREHOUSE_ENTRIES = 50;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface SubscriptionFailure {
  url: string;
  error: string;
}

export interface SubscriptionFetchResult {
  // 合并后的归一化配置 JSON；全部失败时为 null
  configContent: string | null;
  mergedUrls: string[];
  failures: SubscriptionFailure[];
}

export function normalizeSubscriptionUrls(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
    ? input.split(/[\n,;]+/)
    : [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (!seen.has(url.href)) {
        seen.add(url.href);
        urls.push(url.href);
      }
    } catch {
      // 忽略非法地址
    }
  }
  return urls;
}

async function fetchSubscriptionText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, text/plain, */*',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_SUBSCRIPTION_BYTES) {
      throw new Error('订阅内容超过 5MB 限制');
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    if (!text.trim()) throw new Error('订阅内容为空');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;
  const worker = async () => {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  );
  return results;
}

async function resolveSubscription(
  url: string,
  failures: SubscriptionFailure[],
  mergedUrls: Set<string>,
  depth: number
): Promise<Record<string, unknown> | null> {
  try {
    const content = await fetchSubscriptionText(url);
    const normalized = await parseConfigSubscription(content, url);
    const config = JSON.parse(normalized) as Record<string, unknown>;
    const storehouse = extractStoreHouseUrls(config);
    if (storehouse) {
      if (depth >= 1) {
        throw new Error('嵌套多仓不支持，仅展开一层');
      }
      const children = storehouse.slice(0, MAX_STOREHOUSE_ENTRIES);
      const childTasks = children.map(
        (childUrl) => () =>
          resolveSubscription(childUrl, failures, mergedUrls, depth + 1)
      );
      const childResults = await runWithConcurrency(
        childTasks,
        MAX_CONCURRENCY
      );
      const childConfigs = childResults.filter(
        (item): item is Record<string, unknown> => item !== null
      );
      if (childConfigs.length === 0) {
        throw new Error('多仓内所有子订阅均拉取失败');
      }
      return mergeNormalizedConfigs(childConfigs);
    }
    mergedUrls.add(url);
    return config;
  } catch (error) {
    failures.push({
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function fetchAndMergeSubscriptions(
  urls: string[]
): Promise<SubscriptionFetchResult> {
  const failures: SubscriptionFailure[] = [];
  const mergedUrlSet = new Set<string>();
  const tasks = urls.map(
    (url) => () => resolveSubscription(url, failures, mergedUrlSet, 0)
  );
  const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);
  const configs = results.filter(
    (item): item is Record<string, unknown> => item !== null
  );
  if (configs.length === 0) {
    return {
      configContent: null,
      mergedUrls: Array.from(mergedUrlSet),
      failures,
    };
  }
  const merged = mergeNormalizedConfigs(configs);
  return {
    configContent: JSON.stringify(merged),
    mergedUrls: Array.from(mergedUrlSet),
    failures,
  };
}
