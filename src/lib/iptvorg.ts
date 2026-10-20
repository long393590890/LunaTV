/* eslint-disable no-console */

// iptv-org 公共 IPTV 源接入：
// 拉取并缓存 https://iptv-org.github.io/api/ 的 channels/streams/logos/countries，
// 按 LunaTV 直播链路（parseM3U）的期望生成标准 m3u 播放列表。
// 注意（2026-10 实测 schema）：country 为字符串代码；logo 在 logos.json（channel+feed 维度，
// 带 in_use 标记）；streams.json 中 channel 为 null 的是未关联频道的孤儿流，直接跳过。

const IPTVORG_BASE = 'https://iptv-org.github.io/api';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时
const FETCH_TIMEOUT_MS = 30_000;

export interface IptvOrgChannel {
  id: string;
  name: string;
  // ISO 3166-1 alpha-2 代码（iptv-org 实际使用 "UK" 而非 "GB"）
  country?: string | null;
  categories?: string[];
  closed?: boolean | string | null;
  is_nsfw?: boolean;
}

export interface IptvOrgStream {
  channel?: string | null;
  feed?: string | null;
  title?: string | null;
  quality?: string | null;
  url: string;
}

interface IptvOrgSnapshot {
  channels: Map<string, IptvOrgChannel>;
  // channelId → 该频道的流地址列表（保序）
  streams: Map<string, IptvOrgStream[]>;
  // channelId → logo URL（优先 in_use 的）
  logos: Map<string, string>;
  // 国家代码（小写）→ 国家显示名
  countryNames: Map<string, string>;
  fetchedAt: number;
}

let cachedSnapshot: IptvOrgSnapshot | null = null;
let cachedSnapshotPromise: Promise<IptvOrgSnapshot> | null = null;

async function fetchJson(name: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${IPTVORG_BASE}/${name}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LunaTV)',
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`iptv-org ${name} 拉取失败: HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function buildSnapshot(raw: {
  channels: unknown;
  streams: unknown;
  logos?: unknown;
  countries?: unknown;
}): IptvOrgSnapshot {
  const channels = new Map<string, IptvOrgChannel>();
  if (Array.isArray(raw.channels)) {
    for (const item of raw.channels) {
      if (!item || typeof item !== 'object') continue;
      const ch = item as Record<string, unknown>;
      const id = typeof ch.id === 'string' ? ch.id : '';
      const name = typeof ch.name === 'string' ? ch.name : '';
      if (!id || !name) continue;
      channels.set(id, {
        id,
        name,
        country:
          typeof ch.country === 'string'
            ? ch.country.toLowerCase()
            : ch.country &&
              typeof ch.country === 'object' &&
              typeof (ch.country as Record<string, unknown>).code === 'string'
            ? (
                (ch.country as Record<string, unknown>).code as string
              ).toLowerCase()
            : null,
        categories: Array.isArray(ch.categories)
          ? ch.categories.filter((c): c is string => typeof c === 'string')
          : [],
        closed: ch.closed as IptvOrgChannel['closed'],
        is_nsfw: ch.is_nsfw === true,
      });
    }
  }

  const streams = new Map<string, IptvOrgStream[]>();
  if (Array.isArray(raw.streams)) {
    for (const item of raw.streams) {
      if (!item || typeof item !== 'object') continue;
      const s = item as Record<string, unknown>;
      const url = typeof s.url === 'string' ? s.url : '';
      const channelId = typeof s.channel === 'string' ? s.channel : '';
      if (!url || !channelId || !channels.has(channelId)) continue;
      const entry: IptvOrgStream = {
        channel: channelId,
        feed: typeof s.feed === 'string' ? s.feed : null,
        url,
        quality:
          typeof s.quality === 'string'
            ? s.quality
            : typeof s.title === 'string'
            ? s.title
            : null,
      };
      const list = streams.get(channelId);
      if (list) list.push(entry);
      else streams.set(channelId, [entry]);
    }
  }

  // logos.json: {channel, feed, in_use, url}；每频道取一个，优先 in_use
  const logos = new Map<string, string>();
  if (Array.isArray(raw.logos)) {
    for (const item of raw.logos) {
      if (!item || typeof item !== 'object') continue;
      const l = item as Record<string, unknown>;
      const channelId = typeof l.channel === 'string' ? l.channel : '';
      const url = typeof l.url === 'string' ? l.url : '';
      if (!channelId || !url || !channels.has(channelId)) continue;
      const existing = logos.get(channelId);
      if (!existing || l.in_use === true) {
        logos.set(channelId, url);
      }
    }
  }

  // countries.json: [{code, name, ...}]
  const countryNames = new Map<string, string>();
  if (Array.isArray(raw.countries)) {
    for (const item of raw.countries) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      const code = typeof c.code === 'string' ? c.code.toLowerCase() : '';
      const name = typeof c.name === 'string' ? c.name : '';
      if (code && name) countryNames.set(code, name);
    }
  }

  return { channels, streams, logos, countryNames, fetchedAt: Date.now() };
}

async function fetchSnapshot(): Promise<IptvOrgSnapshot> {
  // channels.json 失败则整体不可用；logos/countries 失败仅降级（无 logo/国家名显示为代码）
  const [rawChannels, rawStreams, rawLogos, rawCountries] = await Promise.all([
    fetchJson('channels.json'),
    fetchJson('streams.json').catch((error) => {
      console.error('iptv-org streams.json 拉取失败:', error);
      return [] as unknown;
    }),
    fetchJson('logos.json').catch((error) => {
      console.error('iptv-org logos.json 拉取失败:', error);
      return [] as unknown;
    }),
    fetchJson('countries.json').catch((error) => {
      console.error('iptv-org countries.json 拉取失败:', error);
      return [] as unknown;
    }),
  ]);
  const snapshot = buildSnapshot({
    channels: rawChannels,
    streams: rawStreams,
    logos: rawLogos,
    countries: rawCountries,
  });
  if (snapshot.channels.size === 0) {
    throw new Error('iptv-org 数据为空：channels.json 解析后无有效频道');
  }
  return snapshot;
}

async function getSnapshot(forceRefresh = false): Promise<IptvOrgSnapshot> {
  if (
    !forceRefresh &&
    cachedSnapshot &&
    Date.now() - cachedSnapshot.fetchedAt < CACHE_TTL_MS
  ) {
    return cachedSnapshot;
  }
  if (!cachedSnapshotPromise || forceRefresh) {
    cachedSnapshotPromise = fetchSnapshot()
      .then((snapshot) => {
        cachedSnapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        cachedSnapshotPromise = null;
      });
  }
  return cachedSnapshotPromise;
}

export interface BuildM3uOptions {
  // ISO 3166-1 alpha-2 国家代码小写（iptv-org 用 "uk"），如 ['cn','hk']；空 = 全部
  countries?: string[];
  // iptv-org 分类，如 ['news','music']；空 = 全部
  categories?: string[];
  // 仅保留 https 流（国内网络 http 流易被劫持/阻断）
  httpsOnly?: boolean;
  // 过滤 NSFW 频道（默认过滤）
  includeNsfw?: boolean;
  // 最大频道条目数（多流条目单独计数），默认 2000，上限 10000
  limit?: number;
  forceRefresh?: boolean;
}

function normalizeList(value: string[] | undefined): Set<string> {
  return new Set(
    (value || [])
      .map((v) => v.trim().toLowerCase())
      .filter((v): v is string => v.length > 0)
  );
}

export function buildIptvOrgM3u(options: BuildM3uOptions = {}): string {
  const { httpsOnly = false, includeNsfw = false } = options;
  const countryFilter = normalizeList(options.countries);
  const categoryFilter = normalizeList(options.categories);
  const limit = Math.min(Math.max(options.limit ?? 2000, 1), 10000);

  // 注意：buildIptvOrgM3u 是同步函数，快照必须已存在。
  // 路由层先 await getSnapshot() 再调用本函数。
  const snapshot = cachedSnapshot;
  if (!snapshot) {
    throw new Error('iptv-org 快照未就绪');
  }

  const entries: { line: string; sortKey: string }[] = [];
  let count = 0;

  for (const channel of Array.from(snapshot.channels.values())) {
    if (count >= limit) break;
    if (channel.closed === true) continue;
    if (channel.is_nsfw && !includeNsfw) continue;
    if (countryFilter.size) {
      const code = channel.country || '';
      if (!code || !countryFilter.has(code)) continue;
    }
    if (categoryFilter.size) {
      const cats: string[] = (channel.categories || []).map((c: string) =>
        c.toLowerCase()
      );
      if (!cats.some((c: string) => categoryFilter.has(c))) continue;
    }

    const channelStreams = snapshot.streams.get(channel.id) || [];
    const usable = httpsOnly
      ? channelStreams.filter((s) => s.url.startsWith('https://'))
      : channelStreams;
    if (usable.length === 0) continue;

    const code = channel.country || '';
    const countryName =
      snapshot.countryNames.get(code) || code.toUpperCase() || '未知地区';
    const primaryCategory = (channel.categories || [])[0] || 'general';
    const groupTitle = `${countryName} · ${primaryCategory}`;
    const logo = snapshot.logos.get(channel.id) || '';
    const sortKey = `${code}|${channel.name.toLowerCase()}`;

    usable.forEach((stream, index) => {
      if (count >= limit) return;
      const display =
        usable.length > 1 ? `${channel.name}｜源${index + 1}` : channel.name;
      const attrs = [`tvg-id="${channel.id}"`];
      if (logo) attrs.push(`tvg-logo="${logo.replace(/"/g, '%22')}"`);
      attrs.push(`group-title="${groupTitle.replace(/"/g, '%22')}"`);
      const quality = stream.quality ? ` [${stream.quality}]` : '';
      entries.push({
        line: `#EXTINF:-1 ${attrs.join(' ')},${display}${quality}\n${
          stream.url
        }`,
        sortKey,
      });
      count += 1;
    });
  }

  entries.sort((a, b) =>
    a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0
  );

  const lines = ['#EXTM3U', ...entries.map((e) => e.line)];
  return lines.join('\n') + '\n';
}

export async function getIptvOrgM3u(
  options: BuildM3uOptions = {}
): Promise<string> {
  await getSnapshot(options.forceRefresh);
  return buildIptvOrgM3u(options);
}

// 仅供测试使用：注入/构建快照
export function __setCachedSnapshotForTest(snapshot: IptvOrgSnapshot | null) {
  cachedSnapshot = snapshot;
}

export function __buildSnapshotForTest(
  rawChannels: unknown,
  rawStreams: unknown,
  rawLogos?: unknown,
  rawCountries?: unknown
): IptvOrgSnapshot {
  return buildSnapshot({
    channels: rawChannels,
    streams: rawStreams,
    logos: rawLogos,
    countries: rawCountries,
  });
}
