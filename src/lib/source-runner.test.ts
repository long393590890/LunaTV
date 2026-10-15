/** @jest-environment node */
/* eslint-env jest */
import {
  createMediaUrl,
  readMediaToken,
  rewriteHls,
  validateMediaUrl,
} from './source-media';
import {
  callSourceRunner,
  normalizePlayResponse,
  validOpaqueId,
} from './source-runner';

jest.mock('@/lib/config', () => ({}));

describe('运行器播放响应', () => {
  it('仅允许明确数字parse=0并保留标签地址对', () => {
    expect(
      normalizePlayResponse({
        parse: 0,
        url: [
          '高清',
          'https://media.example/a.mp4?token=x',
          '备用',
          'https://media.example/b',
        ],
      })
    ).toHaveLength(2);
    expect(() =>
      normalizePlayResponse({ parse: '0', url: 'https://media.example/a' })
    ).toThrow('UNSUPPORTED_PARSE');
    expect(() =>
      normalizePlayResponse({ parse: 1, url: 'https://media.example/a' })
    ).toThrow('UNSUPPORTED_PARSE');
    expect(() =>
      normalizePlayResponse({ parse: 0, url: ['高清', 'javascript:alert(1)'] })
    ).toThrow();
    expect(() =>
      normalizePlayResponse({
        parse: 0,
        url: ['高清', 'https://media.example/a', '残缺'],
      })
    ).toThrow();
  });
  it('不同siteType始终调用gateway固定3路径', async () => {
    const original = { ...process.env };
    const originalFetch = global.fetch;
    try {
      process.env.SOURCE_RUNNER_URL = 'https://runner.example/base';
      process.env.SOURCE_RUNNER_TOKEN = 'test-token';
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, text: async () => '{}' });
      await callSourceRunner(
        { key: 'cat', name: 'cat', api: '', protocol: 'catjs', siteType: 4 },
        'search',
        { wd: '测试' }
      );
      expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toBe(
        'https://runner.example/base/spider/cat/3/search'
      );
    } finally {
      process.env = original;
      global.fetch = originalFetch;
    }
  });
  it('允许opaque ID并拒绝控制符及超长输入', () => {
    expect(validOpaqueId('/a/b+c==')).toBe(true);
    expect(validOpaqueId('a\nb')).toBe(false);
    expect(validOpaqueId('a'.repeat(8193))).toBe(false);
  });
});

describe('媒体代理令牌与目标', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.SOURCE_MEDIA_SECRET = 'shared-test-secret';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });
  it('缺失共享密钥明确失败并允许不同模块实例解密', () => {
    delete process.env.SOURCE_MEDIA_SECRET;
    delete process.env.SOURCE_RUNNER_TOKEN;
    expect(() => createMediaUrl(grant)).toThrow('SOURCE_MEDIA_SECRET');
    process.env.SOURCE_RUNNER_TOKEN = 'shared-runner-secret';
    const token = createMediaUrl(grant).split('token=')[1];
    jest.isolateModules(() => {
      const otherInstance = jest.requireActual('./source-media');
      expect(otherInstance.readMediaToken(token)).toEqual(grant);
    });
  });
  const grant = {
    url: 'https://media.example/a.m3u8',
    headers: { Referer: 'https://origin.example/', Cookie: 'secret-cookie' },
    user: 'alice',
    source: 'cat',
    expires: Date.now() + 60000,
  };
  it('加密令牌不公开请求头并拒绝篡改和过期', () => {
    const token = createMediaUrl(grant).split('token=')[1];
    expect(token).not.toContain('secret-cookie');
    expect(readMediaToken(token)).toEqual(grant);
    expect(() => readMediaToken('AAAA' + token.slice(4))).toThrow();
    expect(() =>
      readMediaToken(
        createMediaUrl({ ...grant, expires: 1 }).split('token=')[1]
      )
    ).toThrow();
  });
  it('重写HLS子清单、片段与KEY并保留授权上下文', () => {
    const text =
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nchild/list.m3u8\nseg.ts\n';
    const output = rewriteHls(text, grant.url, grant);
    const tokens = Array.from(output.matchAll(/token=([A-Za-z0-9_-]+)/g)).map(
      (m) => readMediaToken(m[1])
    );
    expect(tokens.map((entry) => entry.url)).toEqual([
      'https://media.example/key.bin',
      'https://media.example/child/list.m3u8',
      'https://media.example/seg.ts',
    ]);
    expect(
      tokens.every(
        (entry) =>
          entry.headers.Cookie === 'secret-cookie' && entry.user === 'alice'
      )
    ).toBe(true);
  });
  it('子清单再次重写仍保留请求头且不继承父请求Range', () => {
    const parent = rewriteHls('child/list.m3u8', grant.url, {
      ...grant,
      headers: { ...grant.headers, Range: 'bytes=0-100' },
    });
    const childGrant = readMediaToken(parent.split('token=')[1]);
    const child = rewriteHls('seg.ts', childGrant.url, childGrant);
    const segment = readMediaToken(child.split('token=')[1]);
    expect(segment.url).toBe('https://media.example/child/seg.ts');
    expect(segment.headers).toEqual(grant.headers);
    expect(segment.expires).toBe(grant.expires);
  });
  it('跨域HLS地址不继承Cookie及Authorization', () => {
    const output = rewriteHls('https://other.example/seg.ts', grant.url, grant);
    const rewritten = readMediaToken(output.split('token=')[1]);
    expect(rewritten.headers.Cookie).toBeUndefined();
    expect(rewritten.headers.Referer).toBe(grant.headers.Referer);
  });
  it('拒绝回环、映射IPv6、私网和非HTTP地址', () => {
    for (const url of [
      'http://127.0.0.1/a',
      'http://0x7f000001/a',
      'http://[::ffff:127.0.0.1]/a',
      'http://10.0.0.1/a',
      'http://169.254.169.254/a',
      'file:///a',
      'https://user:pass@media.example/a',
    ])
      expect(() => validateMediaUrl(url)).toThrow();
  });
});
