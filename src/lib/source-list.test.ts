/* eslint-env jest */
import { filterAndSortSources, VideoInfo } from './source-list';
import type { SearchResult } from './types';

const sources = ['Alpha', 'Beta', 'Gamma', 'Failed', 'Unknown'].map(
  (source_name, index) =>
    ({
      source: String(index),
      id: '1',
      source_name,
      title: '共同影片标题',
    } as SearchResult)
);
const infoMap = new Map<string, VideoInfo>([
  [
    '0-1',
    {
      quality: '720p',
      loadSpeed: '9 MB/s',
      loadSpeedKBps: 1000,
      pingTime: 100,
    },
  ],
  [
    '1-1',
    { quality: '720p', loadSpeed: '1 KB/s', loadSpeedKBps: 2000, pingTime: 50 },
  ],
  [
    '2-1',
    { quality: '720p', loadSpeed: '未知', loadSpeedKBps: 2000, pingTime: 50 },
  ],
  [
    '3-1',
    {
      quality: '错误',
      loadSpeed: '10 MB/s',
      loadSpeedKBps: 10000,
      pingTime: 1,
      hasError: true,
    },
  ],
]);
const names = (field: 'speed' | 'latency', ascending: boolean, query = '') =>
  filterAndSortSources(sources, infoMap, query, { field, ascending }).map(
    (source) => source.source_name
  );

test('网速按原始数值排序，同值稳定，失败/未知始终最后', () => {
  expect(names('speed', false)).toEqual([
    'Beta',
    'Gamma',
    'Alpha',
    'Failed',
    'Unknown',
  ]);
  expect(names('speed', true)).toEqual([
    'Alpha',
    'Beta',
    'Gamma',
    'Failed',
    'Unknown',
  ]);
  expect(sources.map((source) => source.source_name)).toEqual([
    'Alpha',
    'Beta',
    'Gamma',
    'Failed',
    'Unknown',
  ]);
});

test('延迟默认升序并支持降序，同值稳定', () => {
  expect(names('latency', true)).toEqual([
    'Beta',
    'Gamma',
    'Alpha',
    'Failed',
    'Unknown',
  ]);
  expect(names('latency', false)).toEqual([
    'Alpha',
    'Beta',
    'Gamma',
    'Failed',
    'Unknown',
  ]);
});

test('搜索仅匹配源名称，忽略首尾空白和大小写', () => {
  expect(names('speed', false, ' ALp ')).toEqual(['Alpha']);
  expect(names('speed', false, '共同影片')).toEqual([]);
});

test('旧测速结果缺少原始网速时不解析展示字符串', () => {
  const oldInfo = new Map<string, VideoInfo>([
    ['0-1', { quality: '720p', loadSpeed: '100 MB/s', pingTime: 10 }],
    [
      '1-1',
      { quality: '720p', loadSpeed: '1 KB/s', loadSpeedKBps: 1, pingTime: 20 },
    ],
  ]);
  expect(
    filterAndSortSources(sources, oldInfo, '', {
      field: 'speed',
      ascending: false,
    })[0]
  ).toBe(sources[1]);
});

test('无效测速值排后，全部未知时保持原顺序', () => {
  const invalid = new Map(infoMap);
  invalid.set('0-1', {
    quality: '未知',
    loadSpeed: '未知',
    loadSpeedKBps: NaN,
    pingTime: 0,
  });
  invalid.set('1-1', {
    quality: '未知',
    loadSpeed: '未知',
    loadSpeedKBps: Infinity,
    pingTime: -1,
  });
  expect(
    filterAndSortSources(sources, invalid, '', {
      field: 'speed',
      ascending: false,
    })[0]
  ).toBe(sources[2]);
  expect(
    filterAndSortSources(sources, new Map(), '', {
      field: 'latency',
      ascending: true,
    })
  ).toEqual(sources);
});
