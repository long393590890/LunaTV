/* eslint-env jest */
import {
  ensureDetail,
  getDefaultPlayLine,
  getMediaType,
  resolveVideo,
} from './resolveVideo';
import type { SearchResult } from './types';

const summary: SearchResult = {
  source: 'cat',
  id: '内容&一',
  title: '测试',
  episodes: [],
  detailLoaded: false,
  mediaType: 'unknown',
  poster: '',
  episodes_titles: [],
  source_name: '测试源',
  year: '2026',
};
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function mockResponse(data: unknown, ok = true) {
  return Promise.resolve({ ok, json: async () => data } as Response);
}

test('摘要先获取详情，编码内容 ID 并传递取消信号', async () => {
  const controller = new AbortController();
  global.fetch = jest.fn(() => mockResponse({ episodes: ['opaque-id'] }));
  const detail = await ensureDetail(summary, controller.signal);
  expect(detail.episodes).toEqual(['opaque-id']);
  expect(detail.detailLoaded).toBe(true);
  const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
  expect(new URL(url, 'http://localhost').searchParams.get('id')).toBe(
    '内容&一'
  );
  expect(options.signal).toBe(controller.signal);
});

test('默认线路匹配实际剧集列表而非始终选择第一线路', async () => {
  const source: SearchResult = {
    ...summary,
    episodes: ['http-long-1', 'http-long-2'],
    playLines: [
      { name: '首条', episodes: ['opaque'], titles: ['一'] },
      {
        name: '最长HTTP',
        episodes: ['http-long-1', 'http-long-2'],
        titles: ['一', '二'],
      },
    ],
  };
  expect(getDefaultPlayLine(source)).toBe('最长HTTP');
  global.fetch = jest.fn(() =>
    mockResponse({ url: '/api/media?token=test', type: 'hls' })
  );
  await resolveVideo(source, 1);
  expect(
    JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
  ).toMatchObject({
    flag: '最长HTTP',
    id: 'http-long-2',
    videoId: source.id,
  });
});

test('已加载详情不重复请求', async () => {
  global.fetch = jest.fn();
  const detail = { ...summary, detailLoaded: true, episodes: ['opaque-id'] };
  expect(await ensureDetail(detail)).toBe(detail);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('所有协议通过 resolve 提交原始播放 ID 和线路', async () => {
  global.fetch = jest.fn(() => mockResponse({ url: '/api/media?token=test' }));
  const controller = new AbortController();
  const result = await resolveVideo(
    { ...summary, episodes: ['opaque&id'] },
    0,
    '线路一',
    controller.signal
  );
  expect(result.url).toContain('/api/media?token=test');
  const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toBe('/api/resolve');
  expect(JSON.parse(options.body)).toEqual({
    source: 'cat',
    videoId: summary.id,
    id: 'opaque&id',
    flag: '线路一',
  });
  expect(options.signal).toBe(controller.signal);
});

test.each(['opaque-id', 'javascript:alert(1)', 'file:///tmp/video'])(
  '拒绝非媒体解析结果 %s',
  async (url) => {
    global.fetch = jest.fn(() => mockResponse({ url }));
    await expect(
      resolveVideo({ ...summary, episodes: ['raw'] }, 0)
    ).rejects.toThrow('有效的媒体地址');
  }
);

test('解析失败不可回退到原始播放 ID', async () => {
  global.fetch = jest.fn(() => mockResponse({ error: '运行器不可用' }, false));
  await expect(
    resolveVideo({ ...summary, episodes: ['raw'] }, 0)
  ).rejects.toThrow('运行器不可用');
});

test.each(['hls', 'mp4'])(
  '保留无扩展名代理的%s类型和清晰度选项',
  async (type) => {
    global.fetch = jest.fn(() =>
      mockResponse({
        url: '/api/media?token=one',
        type,
        urls: [
          { name: '高清', url: '/api/media?token=one' },
          { name: '标清', url: 'https://media.example/video', type: 'mp4' },
          { name: '无效', url: 'javascript:alert(1)' },
        ],
      })
    );
    const result = await resolveVideo({ ...summary, episodes: ['raw'] }, 0);
    expect(result.type).toBe(type);
    expect(result.urls).toEqual([
      { name: '高清', url: 'http://localhost/api/media?token=one', type },
      { name: '标清', url: 'https://media.example/video', type: 'mp4' },
    ]);
  }
);

test('取消解析向上传递AbortError，重试可重新解析', async () => {
  const controller = new AbortController();
  const aborted = new DOMException('已取消', 'AbortError');
  global.fetch = jest
    .fn()
    .mockRejectedValueOnce(aborted)
    .mockImplementationOnce(() =>
      mockResponse({ url: '/api/media?token=retry', type: 'mp4' })
    );
  controller.abort();
  await expect(
    resolveVideo(
      { ...summary, episodes: ['raw'] },
      0,
      '线路',
      controller.signal
    )
  ).rejects.toHaveProperty('name', 'AbortError');
  await expect(
    resolveVideo({ ...summary, episodes: ['raw'] }, 0)
  ).resolves.toHaveProperty('type', 'mp4');
});

test('未知类型摘要不根据空剧集推断成电影或电视剧', () => {
  expect(getMediaType(summary)).toBe('unknown');
  expect(
    getMediaType({ ...summary, mediaType: undefined, episodes: ['raw'] })
  ).toBe('unknown');
  expect(
    getMediaType({
      ...summary,
      mediaType: undefined,
      detailLoaded: true,
      episodes: ['raw'],
    })
  ).toBe('movie');
});
