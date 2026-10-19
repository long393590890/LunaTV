function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveResource(value: string, baseUrl?: string): string {
  if (
    !baseUrl ||
    (/^csp_|^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:/i.test(value)) ||
    !/^(?:https?:\/\/|\/|\.\/|\.\.\/)|\.(?:m?js|jar|json|txt)(?:[?;#]|$)/i.test(
      value
    )
  )
    return value;
  const [resource, ...suffix] = value.split(';');
  try {
    return [new URL(resource, baseUrl).href, ...suffix].join(';');
  } catch {
    return value;
  }
}

function resolveExt(value: unknown, baseUrl?: string): unknown {
  if (typeof value === 'string') return resolveResource(value, baseUrl);
  if (Array.isArray(value))
    return value.map((item) => resolveExt(item, baseUrl));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveExt(item, baseUrl),
      ])
    );
  }
  return value;
}

export function validateSourceKey(key: unknown): asserts key is string {
  if (
    typeof key !== 'string' ||
    !key.trim() ||
    key.includes('+') ||
    Array.from(key).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  ) {
    throw new Error('源 key 必须为非空字符串，且不能包含 + 或控制字符');
  }
}

export function validateSourceProtocol(site: Record<string, unknown>): void {
  if (
    site.protocol !== undefined &&
    !['cms', 'catjs', 'csp'].includes(site.protocol as string)
  ) {
    throw new Error('protocol 必须为 cms、catjs 或 csp');
  }
  for (const field of ['runnerSite', 'spider', 'runtimeStatus']) {
    if (site[field] !== undefined && typeof site[field] !== 'string') {
      throw new Error(`${field} 必须为字符串`);
    }
  }
  if (
    site.siteType !== undefined &&
    (typeof site.siteType !== 'number' || !Number.isInteger(site.siteType))
  ) {
    throw new Error('siteType 必须为整数');
  }
}

export function normalizeConfigObject(
  config: unknown,
  baseUrl?: string
): Record<string, unknown> {
  if (!isObject(config)) throw new Error('订阅配置顶层必须是 JSON 对象');
  const normalized = { ...config };
  if (config.api_site !== undefined && !isObject(config.api_site)) {
    throw new Error('订阅配置 api_site 必须是对象');
  }
  const sites: Record<string, unknown> = Object.assign(
    Object.create(null),
    config.api_site || {}
  );
  if (config.sites !== undefined) {
    if (!Array.isArray(config.sites))
      throw new Error('订阅配置 sites 必须为数组');
    const keys = new Set<string>();
    for (const site of config.sites) {
      if (!isObject(site) || typeof site.key !== 'string' || !site.key.trim()) {
        throw new Error('订阅配置 sites 必须包含非空 key');
      }
      validateSourceKey(site.key);
      if (keys.has(site.key)) {
        throw new Error(`订阅配置源 key 重复：${site.key}`);
      }
      keys.add(site.key);
      if (Object.prototype.hasOwnProperty.call(sites, site.key)) continue;
      const api = typeof site.api === 'string' ? site.api : '';
      const protocol =
        site.protocol ??
        (/\.m?js(?:[?;#]|$)|;md5;/i.test(api) && !/\.jar(?:[?;#]|$)/i.test(api)
          ? 'catjs'
          : /^csp_/i.test(api) || site.type === 3
          ? 'csp'
          : 'cms');
      sites[site.key] = {
        ...site,
        protocol,
        runnerSite: site.runnerSite ?? site.key,
        siteType: site.siteType ?? site.type,
        spider: site.spider ?? config.spider,
        ...([0, 4].includes(site.type as number)
          ? { runtimeStatus: 'unsupported' }
          : {}),
      };
    }
  }
  for (const [key, site] of Object.entries(sites)) {
    if (
      !key.trim() ||
      !isObject(site) ||
      typeof site.name !== 'string' ||
      !site.name.trim() ||
      typeof site.api !== 'string' ||
      !site.api.trim() ||
      (site.detail !== undefined && typeof site.detail !== 'string')
    ) {
      throw new Error(
        `订阅配置 api_site[${key}] 必须包含非空 name、api 字符串，detail 如提供必须为字符串`
      );
    }
    validateSourceKey(key);
    validateSourceProtocol(site);
    sites[key] = {
      ...site,
      api: resolveResource(site.api, baseUrl),
      ...(typeof site.spider === 'string'
        ? { spider: resolveResource(site.spider, baseUrl) }
        : {}),
      ...(site.ext !== undefined ? { ext: resolveExt(site.ext, baseUrl) } : {}),
    };
  }
  if (config.api_site !== undefined || config.sites !== undefined)
    normalized.api_site = sites;
  if (typeof config.spider === 'string')
    normalized.spider = resolveResource(config.spider, baseUrl);
  // 保留解析器及原始 TVBox 元数据，运行时只消费归一后的 api_site。
  return normalized;
}

export async function parseConfigSubscription(
  content: string,
  baseUrl?: string
): Promise<string> {
  let text = content.trim();
  if (!text) throw new Error('订阅配置内容为空');
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) {
      throw new Error(
        '订阅配置格式错误：请输入有效 JSON 或 Base58 编码的 JSON'
      );
    }
    try {
      const bs58 = (await import('bs58')).default;
      text = new TextDecoder('utf-8', { fatal: true })
        .decode(bs58.decode(text))
        .trim();
    } catch {
      throw new Error('订阅配置 Base58 解码失败：内容必须为 UTF-8 JSON');
    }
    try {
      config = JSON.parse(text);
    } catch {
      throw new Error('订阅配置 Base58 解码后不是有效 JSON');
    }
  }
  return JSON.stringify(normalizeConfigObject(config, baseUrl));
}

// ---------- 批量订阅：多仓识别与多配置合并 ----------

export interface StoreHouseEntry {
  name?: string;
  url?: unknown;
}

export function extractStoreHouseUrls(config: unknown): string[] | null {
  if (!isObject(config)) return null;
  const sites = (config as Record<string, unknown>).sites;
  const apiSite = (config as Record<string, unknown>).api_site;
  if (sites !== undefined || apiSite !== undefined) return null;
  const urls = (config as Record<string, unknown>).urls;
  if (!Array.isArray(urls) || urls.length === 0) return null;
  const out: string[] = [];
  for (const entry of urls) {
    let value: unknown;
    if (typeof entry === 'string') value = entry;
    else if (isObject(entry)) value = entry.url;
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        out.push(url.href);
      }
    } catch {
      // 忽略非法地址
    }
  }
  return out.length > 0 ? out : null;
}

function siteSignature(site: Record<string, unknown>): string {
  return JSON.stringify([site.api, site.name, site.protocol, site.ext]);
}

export interface MergedConfig {
  api_site: Record<string, unknown>;
  custom_category?: Record<string, unknown>[];
  lives?: Record<string, unknown>;
  cache_time?: number;
  [key: string]: unknown;
}

export function mergeNormalizedConfigs(
  configs: Record<string, unknown>[]
): MergedConfig {
  if (configs.length === 1) {
    return configs[0] as unknown as MergedConfig;
  }
  const merged: Record<string, unknown> = {};
  const apiSite: Record<string, unknown> = {};
  const apiSiteIndex = new Map<string, string>();
  const customCategories: Record<string, unknown>[] = [];
  const categoryIndex = new Set<string>();
  const lives: Record<string, unknown> = {};
  let cacheTime: number | undefined;

  for (const config of configs) {
    const sites = isObject(config.api_site) ? config.api_site : {};
    for (const [key, raw] of Object.entries(sites)) {
      if (!isObject(raw)) continue;
      const site = { ...raw };
      let finalKey = key;
      let seq = 2;
      while (Object.prototype.hasOwnProperty.call(apiSite, finalKey)) {
        // 同 key 同内容视为同一源，跳过重复
        if (apiSiteIndex.get(finalKey) === siteSignature(site)) break;
        finalKey = `${key}_${seq++}`;
      }
      if (Object.prototype.hasOwnProperty.call(apiSite, finalKey)) continue;
      if (finalKey !== key) {
        site.runnerSite =
          typeof site.runnerSite === 'string' && site.runnerSite
            ? site.runnerSite
            : finalKey;
      }
      apiSite[finalKey] = site;
      apiSiteIndex.set(finalKey, siteSignature(site));
    }
    const categories = Array.isArray(config.custom_category)
      ? config.custom_category
      : [];
    for (const raw of categories) {
      if (!isObject(raw)) continue;
      const category = raw as Record<string, unknown>;
      const index = `${category.query}+${category.type}`;
      if (categoryIndex.has(index)) continue;
      categoryIndex.add(index);
      customCategories.push(category);
    }
    const configLives = isObject(config.lives) ? config.lives : {};
    for (const [key, live] of Object.entries(configLives)) {
      if (Object.prototype.hasOwnProperty.call(lives, key)) continue;
      lives[key] = live;
    }
    if (typeof config.cache_time === 'number') {
      cacheTime =
        cacheTime === undefined
          ? config.cache_time
          : Math.min(cacheTime, config.cache_time);
    }
  }

  merged.api_site = apiSite;
  if (customCategories.length > 0) merged.custom_category = customCategories;
  if (Object.keys(lives).length > 0) merged.lives = lives;
  if (cacheTime !== undefined) merged.cache_time = cacheTime;
  return merged as MergedConfig;
}
