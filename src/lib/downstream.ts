import { createHash } from 'crypto';

import { API_CONFIG, ApiSite, getConfig } from '@/lib/config';
import { getCachedSearchPage, setCachedSearchPage } from '@/lib/search-cache';
import {
  callSourceRunner,
  isRunnerSource,
  validOpaqueId,
} from '@/lib/source-runner';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';

interface ApiSearchItem {
  vod_id: string | number;
  vod_name?: string;
  vod_pic?: string;
  vod_play_url?: string;
  vod_play_from?: string;
  vod_class?: string;
  vod_year?: string | number;
  vod_content?: string;
  vod_douban_id?: number;
  type_name?: string;
}

export function parsePlayLines(
  playUrl = '',
  playFrom = ''
): NonNullable<SearchResult['playLines']> {
  const names = playFrom.split('$$$');
  return playUrl
    .split('$$$')
    .map((line, index) => {
      const episodes: string[] = [];
      const titles: string[] = [];
      line.split('#').forEach((entry) => {
        if (!entry) return;
        const separator = entry.indexOf('$');
        const id = separator < 0 ? entry : entry.slice(separator + 1);
        if (!validOpaqueId(id)) return;
        titles.push(
          separator < 0
            ? String(episodes.length + 1)
            : entry.slice(0, separator)
        );
        episodes.push(id);
      });
      return { name: names[index] || `线路${index + 1}`, episodes, titles };
    })
    .filter((line) => line.episodes.length > 0);
}

export function normalizeSourceItem(
  item: ApiSearchItem,
  site: ApiSite,
  detailLoaded: boolean
): SearchResult {
  const playLines = parsePlayLines(item.vod_play_url, item.vod_play_from);
  const directLines = playLines.filter((line) =>
    line.episodes.every((episode) => /^https?:\/\//i.test(episode))
  );
  const first = isRunnerSource(site)
    ? playLines[0]
    : [...directLines].sort(
        (a, b) => b.episodes.length - a.episodes.length
      )[0] || playLines[0];
  const category = item.type_name || item.vod_class || '';
  return {
    id: String(item.vod_id),
    title: String(item.vod_name || '')
      .trim()
      .replace(/\s+/g, ' '),
    poster: item.vod_pic || '',
    episodes: first?.episodes || [],
    episodes_titles: first?.titles || [],
    playLines: first
      ? [first, ...playLines.filter((line) => line !== first)]
      : playLines,
    detailLoaded,
    mediaType: /电影/.test(category)
      ? 'movie'
      : /电视剧|连续剧|动漫|综艺|短剧/.test(category)
      ? 'tv'
      : 'unknown',
    source: site.key,
    source_name: site.name,
    class: item.vod_class,
    year: String(item.vod_year || '').match(/\d{4}/)?.[0] || 'unknown',
    desc: cleanHtmlTags(item.vod_content || ''),
    type_name: item.type_name,
    douban_id: item.vod_douban_id,
  };
}

async function cmsRequest(
  url: string,
  timeout: number
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`源请求失败 (${response.status})`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function sourceCacheKey(site: ApiSite): string {
  return `${site.key}:${createHash('sha256')
    .update(JSON.stringify(site))
    .digest('hex')}`;
}

function cmsUrl(site: ApiSite, params: Record<string, string>): string {
  const url = new URL(site.api);
  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value)
  );
  return url.href;
}

async function searchPage(
  site: ApiSite,
  query: string,
  page: number
): Promise<{ results: SearchResult[]; pageCount: number }> {
  const runner = isRunnerSource(site);
  const cacheKey = sourceCacheKey(site);
  const cached = runner ? null : getCachedSearchPage(cacheKey, query, page);
  if (cached)
    return { results: [...cached.data], pageCount: cached.pageCount || 1 };
  const data = runner
    ? await callSourceRunner(site, 'search', { wd: query, page })
    : await cmsRequest(
        cmsUrl(site, {
          ac: 'videolist',
          wd: query,
          ...(page > 1 ? { pg: String(page) } : {}),
        }),
        8000
      );
  if (!Array.isArray(data.list)) throw new Error('源搜索响应格式无效');
  const results = data.list
    .filter((item) => item && item.vod_id != null)
    .map((item) =>
      normalizeSourceItem(item, site, !runner && !!item.vod_play_url)
    );
  const pageCount = Math.max(1, Number(data.pagecount) || 1);
  if (!runner && results.length) {
    setCachedSearchPage(cacheKey, query, page, 'ok', results, pageCount);
    results
      .filter((item) => item.detailLoaded)
      .forEach((item) =>
        setCachedSearchPage(cacheKey, `detail:${item.id}`, 0, 'ok', [item])
      );
  }
  return { results, pageCount };
}

export async function searchFromApi(
  site: ApiSite,
  query: string
): Promise<SearchResult[]> {
  try {
    return await searchFromApiStrict(site, query);
  } catch {
    return [];
  }
}

export async function searchFromApiStrict(
  site: ApiSite,
  query: string
): Promise<SearchResult[]> {
  const first = await searchPage(site, query, 1);
  const config = await getConfig();
  const max = Math.min(
    first.pageCount,
    config.SiteConfig.SearchDownstreamMaxPage
  );
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, max - 1) }, (_, i) =>
      searchPage(site, query, i + 2).catch(() => ({
        results: [],
        pageCount: 1,
      }))
    )
  );
  return [...first.results, ...rest.flatMap((page) => page.results)];
}

export async function getDetailFromApi(
  site: ApiSite,
  id: string
): Promise<SearchResult> {
  if (!validOpaqueId(id)) throw new Error('无效的视频ID');
  if (!isRunnerSource(site)) {
    const cached = getCachedSearchPage(sourceCacheKey(site), `detail:${id}`, 0);
    if (cached?.data[0]?.detailLoaded) return cached.data[0];
  }
  let data: Record<string, unknown>;
  try {
    data = isRunnerSource(site)
      ? await callSourceRunner(site, 'detail', { id })
      : await cmsRequest(cmsUrl(site, { ac: 'videolist', ids: id }), 10000);
  } catch (error) {
    if (!isRunnerSource(site) && site.detail)
      return handleSpecialSourceDetail(id, site);
    throw error;
  }
  const item = Array.isArray(data.list)
    ? data.list.find((entry) => entry && String(entry.vod_id) === id)
    : undefined;
  if (!item) throw new Error('获取到的详情内容无效或视频ID不匹配');
  const result = normalizeSourceItem(item, site, true);
  if (!result.episodes.length && typeof item.vod_content === 'string') {
    const urls =
      item.vod_content.match(
        /https?:\/\/[^"'\s<>]+?\.m3u8(?:\?[^"'\s<>]*)?/g
      ) || [];
    if (urls.length) {
      result.episodes = urls;
      result.episodes_titles = urls.map((_: string, i: number) =>
        String(i + 1)
      );
      result.playLines = [
        {
          name: '默认',
          episodes: result.episodes,
          titles: result.episodes_titles,
        },
      ];
    }
  }
  if (!result.episodes.length && !isRunnerSource(site) && site.detail)
    return handleSpecialSourceDetail(id, site);
  return result;
}

async function handleSpecialSourceDetail(
  id: string,
  site: ApiSite
): Promise<SearchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(
      `${site.detail}/index.php/vod/detail/id/${encodeURIComponent(id)}.html`,
      {
        headers: API_CONFIG.detail.headers,
        signal: controller.signal,
        cache: 'no-store',
      }
    );
    if (!response.ok) throw new Error(`详情页请求失败 (${response.status})`);
    const html = await response.text();
    let matches =
      site.key === 'ffzy'
        ? html.match(
            /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g
          ) || []
        : [];
    if (!matches.length)
      matches =
        html.match(/\$(https?:\/\/[^"'\s]+?\.m3u8(?:\?[^"'\s<>]*)?)/g) || [];
    const episodes = Array.from(new Set(matches)).map(
      (link) => link.slice(1).split('(')[0]
    );
    const titles = episodes.map((_, i) => String(i + 1));
    return {
      id,
      title: html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]?.trim() || '',
      poster: html.match(/https?:\/\/[^"'\s]+?\.jpg/)?.[0] || '',
      episodes,
      episodes_titles: titles,
      source: site.key,
      source_name: site.name,
      year: html.match(/>(\d{4})</)?.[1] || 'unknown',
      desc: cleanHtmlTags(
        html.match(
          /<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/
        )?.[1] || ''
      ),
      detailLoaded: true,
      mediaType: 'unknown',
      playLines: [{ name: '默认', episodes, titles }],
    };
  } finally {
    clearTimeout(timer);
  }
}
