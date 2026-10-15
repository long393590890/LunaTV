/** @jest-environment node */
/* global describe, it, expect, jest */
jest.mock('@/lib/config', () => ({
  API_CONFIG: { search: { headers: {} } },
  getConfig: jest
    .fn()
    .mockResolvedValue({ SiteConfig: { SearchDownstreamMaxPage: 1 } }),
}));
jest.mock('@/lib/search-cache', () => ({
  getCachedSearchPage: jest.fn(),
  setCachedSearchPage: jest.fn(),
}));
jest.mock('@/lib/utils', () => ({ cleanHtmlTags: (text: string) => text }));
import {
  getDetailFromApi,
  normalizeSourceItem,
  parsePlayLines,
  searchFromApiStrict,
} from './downstream';

describe('多线路源数据', () => {
  it('保留签名m3u8、mp4和opaque播放ID以及完整线路', () => {
    const lines = parsePlayLines(
      '第一集$https://media.example/a.m3u8?t=1#第二集$https://media.example/a.mp4$$$第一集$/opaque/a+b==',
      '直连$$$猫源'
    );
    expect(lines).toHaveLength(2);
    expect(lines[0].episodes).toEqual([
      'https://media.example/a.m3u8?t=1',
      'https://media.example/a.mp4',
    ]);
    expect(lines[1].episodes).toEqual(['/opaque/a+b==']);
  });
  it('CMS默认选择集数最多HTTP直链并将其线路标识同步置首', () => {
    const result = normalizeSourceItem(
      {
        vod_id: 1,
        vod_play_from: '解析$$$短$$$完整',
        vod_play_url:
          '一$opaque#二$opaque2#三$opaque3$$$一$https://media.example/a.mp4$$$一$https://media.example/1.m3u8#二$https://media.example/2.m3u8',
      },
      { key: 'cms', name: 'CMS', api: 'https://cms.example/api' },
      true
    );
    expect(result.episodes).toHaveLength(2);
    expect(result.playLines?.map((line) => line.name)).toEqual([
      '完整',
      '解析',
      '短',
    ]);
    expect(result.episodes).toEqual(result.playLines?.[0].episodes);
  });
  it('CMS搜索保留已有query且完整搜索无需HTML详情', async () => {
    const original = global.fetch;
    try {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          list: [{ vod_id: 1, vod_play_url: '一$https://media.example/a.mp4' }],
        }),
      });
      const site = {
        key: 'cms',
        name: 'CMS',
        api: 'https://cms.example/api?token=secret',
        detail: 'https://cms.example',
      };
      const results = await searchFromApiStrict(site, '标题 & 1');
      expect(results[0].detailLoaded).toBe(true);
      const searchUrl = new URL((global.fetch as jest.Mock).mock.calls[0][0]);
      expect(searchUrl.searchParams.get('token')).toBe('secret');
      expect(searchUrl.searchParams.get('wd')).toBe('标题 & 1');
      await getDetailFromApi(site, '1');
      expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain(
        'token=secret&ac=videolist&ids=1'
      );
    } finally {
      global.fetch = original;
    }
  });
  it('详情只接受请求视频ID对应的可信条目', async () => {
    const original = global.fetch;
    try {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          list: [
            {
              vod_id: 'other',
              vod_play_url: '一$https://media.example/a.mp4',
            },
          ],
        }),
      });
      await expect(
        getDetailFromApi(
          { key: 'cms', name: 'CMS', api: 'https://cms.example' },
          'requested'
        )
      ).rejects.toThrow('视频ID不匹配');
    } finally {
      global.fetch = original;
    }
  });
  it('严格搜索保留源请求错误而空结果正常返回', async () => {
    const original = global.fetch;
    try {
      global.fetch = jest.fn().mockRejectedValue(new Error('源不可用'));
      await expect(
        searchFromApiStrict(
          { key: 'cms', name: 'CMS', api: 'https://cms.example' },
          '测试'
        )
      ).rejects.toThrow('源不可用');
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ error: '接口错误' }),
      });
      await expect(
        searchFromApiStrict(
          { key: 'cms', name: 'CMS', api: 'https://cms.example' },
          '测试'
        )
      ).rejects.toThrow('源搜索响应格式无效');
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ list: [] }),
      });
      await expect(
        searchFromApiStrict(
          { key: 'cms', name: 'CMS', api: 'https://cms.example' },
          '测试'
        )
      ).resolves.toEqual([]);
    } finally {
      global.fetch = original;
    }
  });
  it('不丢弃无剧集的搜索摘要', () => {
    const result = normalizeSourceItem(
      { vod_id: '/a+b', vod_name: ' 动画 ', type_name: '动漫' },
      { key: 'cat', name: '猫源', api: '', protocol: 'catjs' },
      false
    );
    expect(result.id).toBe('/a+b');
    expect(result.episodes).toEqual([]);
    expect(result.detailLoaded).toBe(false);
    expect(result.mediaType).toBe('tv');
  });
});
