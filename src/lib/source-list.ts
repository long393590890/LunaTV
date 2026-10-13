import type { SearchResult } from './types';

export interface VideoInfo {
  quality: string;
  loadSpeed: string;
  loadSpeedKBps?: number;
  pingTime: number;
  hasError?: boolean;
}

export type SourceSort = { field: 'speed' | 'latency'; ascending: boolean };

export function filterAndSortSources(
  sources: SearchResult[],
  infoMap: Map<string, VideoInfo>,
  query: string,
  sort: SourceSort
): SearchResult[] {
  const keyword = query.trim().toLocaleLowerCase();
  const metric = (source: SearchResult): number | undefined => {
    const info = infoMap.get(`${source.source}-${source.id}`);
    if (!info || info.hasError) return undefined;
    const value = sort.field === 'speed' ? info.loadSpeedKBps : info.pingTime;
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : undefined;
  };
  return sources
    .map((source, index) => ({ source, index, value: metric(source) }))
    .filter(({ source }) =>
      source.source_name.toLocaleLowerCase().includes(keyword)
    )
    .sort((a, b) => {
      if (a.value === undefined && b.value !== undefined) return 1;
      if (a.value !== undefined && b.value === undefined) return -1;
      if (
        a.value !== undefined &&
        b.value !== undefined &&
        a.value !== b.value
      ) {
        return sort.ascending ? a.value - b.value : b.value - a.value;
      }
      return a.index - b.index;
    })
    .map(({ source }) => source);
}
