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
