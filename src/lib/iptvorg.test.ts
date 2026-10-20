/** @jest-environment node */
/* eslint-env jest */
import {
  __buildSnapshotForTest,
  __setCachedSnapshotForTest,
  buildIptvOrgM3u,
} from './iptvorg';

// 2026-10 实测 iptv-org schema：country 为字符串代码；logo 在 logos.json；国家名在 countries.json
const channels = [
  {
    id: 'cctv1',
    name: 'CCTV-1',
    country: 'CN',
    categories: ['general', 'news'],
    closed: false,
    is_nsfw: false,
  },
  {
    id: 'cctv5',
    name: 'CCTV-5 体育',
    country: 'CN',
    categories: ['sports'],
    closed: false,
    is_nsfw: false,
  },
  {
    id: 'tvbjade',
    name: 'TVB Jade',
    country: 'HK',
    categories: ['entertainment'],
    closed: false,
    is_nsfw: false,
  },
  {
    id: 'deadchannel',
    name: 'Dead Channel',
    country: 'US',
    categories: ['news'],
    closed: true,
    is_nsfw: false,
  },
  {
    id: 'adultswim',
    name: 'Adult Swim',
    country: 'US',
    categories: ['entertainment'],
    closed: false,
    is_nsfw: true,
  },
];

const streams = [
  { channel: 'cctv1', url: 'http://a.example.com/cctv1.m3u8', quality: '720p' },
  {
    channel: 'cctv1',
    url: 'https://b.example.com/cctv1-hd.m3u8',
    quality: '1080p',
  },
  { channel: 'cctv5', url: 'http://a.example.com/cctv5.m3u8' },
  { channel: 'tvbjade', url: 'https://c.example.com/tvb.m3u8' },
  { channel: 'deadchannel', url: 'https://d.example.com/dead.m3u8' },
  { channel: 'unknown-channel', url: 'https://e.example.com/orphan.m3u8' },
];

const logos = [
  {
    channel: 'cctv1',
    url: 'https://img.example.com/old-cctv1.png',
    in_use: false,
  },
  { channel: 'cctv1', url: 'https://img.example.com/cctv1.png', in_use: true },
  { channel: 'tvbjade', url: 'https://img.example.com/tvb.png', in_use: true },
];

const countries = [
  { code: 'CN', name: 'China' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'US', name: 'United States' },
];

function withSnapshot() {
  __setCachedSnapshotForTest(
    __buildSnapshotForTest(channels, streams, logos, countries)
  );
}

afterEach(() => {
  __setCachedSnapshotForTest(null);
});

describe('buildIptvOrgM3u', () => {
  test('生成标准 m3u：头部、tvg-id/tvg-logo/group-title、多流编号', () => {
    withSnapshot();
    const m3u = buildIptvOrgM3u();
    const lines = m3u.split('\n');
    expect(lines[0]).toBe('#EXTM3U');

    // CCTV-1 有两个流 → 两条目带 ｜源1/｜源2 后缀
    expect(m3u).toContain('CCTV-1｜源1');
    expect(m3u).toContain('CCTV-1｜源2');
    expect(m3u).toContain('tvg-id="cctv1"');
    // logo 取 in_use 的那个
    expect(m3u).toContain('tvg-logo="https://img.example.com/cctv1.png"');
    expect(m3u).not.toContain('old-cctv1.png');
    // 国家名来自 countries.json
    expect(m3u).toContain('group-title="China · general"');
    expect(m3u).toContain('http://a.example.com/cctv1.m3u8');
    expect(m3u).toContain(
      'CCTV-1｜源2 [1080p]\nhttps://b.example.com/cctv1-hd.m3u8'
    );

    // 单流频道无后缀
    expect(m3u).toContain('TVB Jade\nhttps://c.example.com/tvb.m3u8');
    // 已关闭频道被过滤
    expect(m3u).not.toContain('Dead Channel');
    // 未收录频道（streams 里 channel 不在 channels.json）被丢弃
    expect(m3u).not.toContain('orphan.m3u8');
    // NSFW 默认过滤
    expect(m3u).not.toContain('Adult Swim');
  });

  test('国家过滤（小写代码匹配）', () => {
    withSnapshot();
    const m3u = buildIptvOrgM3u({ countries: ['cn'] });
    expect(m3u).toContain('CCTV-1');
    expect(m3u).not.toContain('TVB Jade');
  });

  test('分类过滤', () => {
    withSnapshot();
    const m3u = buildIptvOrgM3u({ categories: ['sports'] });
    expect(m3u).toContain('CCTV-5 体育');
    expect(m3u).not.toContain('CCTV-1｜源1');
    expect(m3u).not.toContain('TVB Jade');
  });

  test('httpsOnly 过滤不安全流', () => {
    withSnapshot();
    const m3u = buildIptvOrgM3u({ httpsOnly: true });
    expect(m3u).toContain('https://b.example.com/cctv1-hd.m3u8');
    expect(m3u).not.toContain('http://a.example.com/cctv1.m3u8');
    // CCTV-5 只有 http 流 → 整个频道消失
    expect(m3u).not.toContain('CCTV-5 体育');
  });

  test('limit 限制条目数量', () => {
    withSnapshot();
    const m3u = buildIptvOrgM3u({ limit: 2 });
    const extinfCount = m3u
      .split('\n')
      .filter((l) => l.startsWith('#EXTINF')).length;
    expect(extinfCount).toBe(2);
  });

  test('无 logo 的频道不输出 tvg-logo 属性', () => {
    withSnapshot();
    const m3u = buildIptvOrgM3u({ categories: ['sports'] });
    expect(m3u).not.toContain('tvg-logo=');
  });

  test('带 user_agent/referrer 的流输出 EXTVLCOPT 行（位于 URL 之后）', () => {
    __setCachedSnapshotForTest(
      __buildSnapshotForTest(
        [
          {
            id: 'ua1',
            name: 'UA TV',
            country: 'CN',
            categories: ['general'],
            closed: false,
          },
        ],
        [
          {
            channel: 'ua1',
            url: 'https://ua.example.com/live.m3u8',
            user_agent: 'okhttp/4.9.0',
            referrer: 'https://tv.example.com/',
          },
        ]
      )
    );
    const m3u = buildIptvOrgM3u();
    const lines = m3u.split('\n');
    const urlIdx = lines.indexOf('https://ua.example.com/live.m3u8');
    expect(urlIdx).toBeGreaterThan(-1);
    // EXTVLCOPT 必须紧跟 URL 行之后（不能打断 EXTINF 与 URL 的配对）
    expect(lines[urlIdx + 1]).toBe('#EXTVLCOPT:http-user-agent=okhttp/4.9.0');
    expect(lines[urlIdx + 2]).toBe(
      '#EXTVLCOPT:http-referrer=https://tv.example.com/'
    );
  });

  test('快照未就绪时抛错（路由层负责先拉取快照）', () => {
    __setCachedSnapshotForTest(null);
    expect(() => buildIptvOrgM3u()).toThrow('快照未就绪');
  });

  test('tvg-logo 中的引号被转义', () => {
    __setCachedSnapshotForTest(
      __buildSnapshotForTest(
        [
          {
            id: 'q1',
            name: 'Quote TV',
            country: 'CN',
            categories: ['general'],
            closed: false,
          },
        ],
        [{ channel: 'q1', url: 'https://q.example.com/live.m3u8' }],
        [
          {
            channel: 'q1',
            url: 'https://img.example.com/a".png',
            in_use: true,
          },
        ],
        [{ code: 'CN', name: 'China' }]
      )
    );
    const m3u = buildIptvOrgM3u();
    expect(m3u).toContain('tvg-logo="https://img.example.com/a%22.png"');
  });
});
