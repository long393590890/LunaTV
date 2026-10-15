/* eslint-disable no-control-regex */
import type { ApiSite } from '@/lib/config';

export function isRunnerSource(site: ApiSite): boolean {
  return site.protocol === 'catjs' || site.protocol === 'csp';
}

export function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 8192 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

export async function callSourceRunner(
  site: ApiSite,
  action: 'init' | 'search' | 'detail' | 'play',
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const base = process.env.SOURCE_RUNNER_URL;
  const token = process.env.SOURCE_RUNNER_TOKEN;
  if (!base || !token) throw new Error('源运行器未配置');
  const endpoint = new URL(base);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('源运行器地址配置无效');
  }
  const siteKey = site.runnerSite || site.key;
  if (!/^[\w-]+$/.test(siteKey)) throw new Error('运行器站点标识无效');
  endpoint.pathname = `${endpoint.pathname.replace(
    /\/$/,
    ''
  )}/spider/${siteKey}/3/${action}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`源运行器请求失败 (${response.status})`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('源运行器响应过大');
    const result = JSON.parse(text);
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('源运行器响应无效');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizePlayResponse(
  data: Record<string, unknown>
): Array<{ name: string; url: string }> {
  if (data.parse !== 0) throw new Error('UNSUPPORTED_PARSE');
  const validUrl = (value: unknown): value is string => {
    if (typeof value !== 'string' || /\s/.test(value)) return false;
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  };
  if (validUrl(data.url)) return [{ name: '默认', url: data.url }];
  if (
    Array.isArray(data.url) &&
    data.url.length >= 2 &&
    data.url.length % 2 === 0
  ) {
    const pairs: Array<{ name: string; url: string }> = [];
    for (let i = 0; i < data.url.length; i += 2) {
      if (
        typeof data.url[i] !== 'string' ||
        !data.url[i].trim() ||
        !validUrl(data.url[i + 1])
      )
        throw new Error('播放地址格式无效');
      pairs.push({ name: data.url[i], url: data.url[i + 1] });
    }
    return pairs;
  }
  throw new Error('播放地址格式无效');
}
