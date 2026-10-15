import { SearchResult } from './types';

export async function ensureDetail(
  source: SearchResult,
  signal?: AbortSignal
): Promise<SearchResult> {
  if (source.detailLoaded !== false && source.episodes?.length) return source;
  const query = new URLSearchParams({ source: source.source, id: source.id });
  const response = await fetch(`/api/detail?${query}`, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '获取视频详情失败');
  if (!data.episodes?.length) throw new Error('该播放源没有可用剧集');
  return { ...source, ...data, detailLoaded: true };
}

export interface ResolvedVideo {
  url: string;
  type?: 'hls' | 'mp4';
  urls?: Array<{ name: string; url: string; type?: 'hls' | 'mp4' }>;
}

export function getDefaultPlayLine(source: SearchResult): string | undefined {
  const lines = source.playLines || [];
  return (
    lines.find(
      (line) =>
        line.episodes.length === source.episodes.length &&
        line.episodes.every(
          (episode, index) => episode === source.episodes[index]
        )
    ) || lines[0]
  )?.name;
}

export async function resolveVideo(
  source: SearchResult,
  episodeIndex: number,
  flag?: string,
  signal?: AbortSignal
): Promise<ResolvedVideo> {
  const id = source.episodes?.[episodeIndex];
  if (!id) throw new Error('该线路没有可用剧集');
  const response = await fetch('/api/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: source.source,
      videoId: source.id,
      id,
      flag: flag || getDefaultPlayLine(source),
    }),
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '播放地址解析失败');
  if (typeof data.url !== 'string' || !data.url.trim()) {
    throw new Error('解析结果缺少播放地址');
  }
  // 只接受浏览器可播放的网络地址或后端同源代理地址，禁止原始播放 ID 回落。
  const url = new URL(data.url, window.location.origin);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('解析结果不是有效的媒体地址');
  }
  if (!/^https?:\/\//i.test(data.url) && !data.url.startsWith('/api/')) {
    throw new Error('解析结果不是有效的媒体地址');
  }
  const type: ResolvedVideo['type'] =
    data.type === 'hls' || data.type === 'mp4' ? data.type : undefined;
  const urls: ResolvedVideo['urls'] = Array.isArray(data.urls)
    ? data.urls
        .filter(
          (item: { name?: unknown; url?: unknown }) =>
            typeof item.name === 'string' &&
            typeof item.url === 'string' &&
            (/^https?:\/\//i.test(item.url) || item.url.startsWith('/api/'))
        )
        .map((item: { name: string; url: string; type?: string }) => ({
          name: item.name,
          url: new URL(item.url, window.location.origin).href,
          type: item.type === 'hls' || item.type === 'mp4' ? item.type : type,
        }))
    : undefined;
  return { url: url.href, type, urls };
}

export function getMediaType(source: SearchResult): 'movie' | 'tv' | 'unknown' {
  if (source.mediaType) return source.mediaType;
  if (source.detailLoaded === false || !source.episodes?.length)
    return 'unknown';
  return source.episodes.length > 1 ? 'tv' : 'movie';
}
