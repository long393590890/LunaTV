/** @jest-environment node */
/* eslint-env jest */
// 批量订阅拉取编排的集成测试：本地 HTTP 服务自包含验证，
// 不访问外部网络。jest 27 环境不转发 Node 18+ 的全局 fetch，
// 这里用 node:http 实现最小 fetch 替身（仅覆盖被测代码用到的子集）。
import http from 'http';
import type { AddressInfo } from 'net';

import {
  fetchAndMergeSubscriptions,
  normalizeSubscriptionUrls,
} from './subscription-remote';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function startServer(handler: Handler): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((accept) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      accept({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// 最小 fetch 替身：GET + 302 跟随 + arrayBuffer()，忽略 signal/cache 等选项
async function minimalFetch(
  input: string,
  init?: { headers?: Record<string, string> }
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}> {
  const parsed = new URL(input);
  const payload = await new Promise<{
    status: number;
    statusText: string;
    body: Buffer;
    location?: string;
  }>((resolve, reject) => {
    const client = parsed.protocol === 'https:' ? require('https') : http;
    const request = client.get(
      parsed,
      { headers: init?.headers },
      (response: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode || 500,
            statusText: response.statusMessage || '',
            body: Buffer.concat(chunks),
            location: response.headers.location as string | undefined,
          })
        );
      }
    );
    request.on('error', reject);
  });
  if ([301, 302, 307, 308].includes(payload.status) && payload.location) {
    return minimalFetch(new URL(payload.location, parsed).href, init);
  }
  return {
    ok: payload.status >= 200 && payload.status < 300,
    status: payload.status,
    statusText: payload.statusText,
    url: input,
    arrayBuffer: async () =>
      payload.body.buffer.slice(
        payload.body.byteOffset,
        payload.body.byteOffset + payload.body.byteLength
      ),
  };
}

// jest 27 node 环境不转发全局 fetch，注入替身
if (typeof globalThis.fetch !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = minimalFetch;
}

const tvBoxConfig = {
  spider: './spider.jar;md5;abc',
  sites: [
    {
      key: 'cms-a',
      name: 'CMS甲',
      type: 1,
      api: './api.php/provide/vod',
    },
    {
      key: 'spider-b',
      name: '爬虫乙',
      type: 3,
      api: 'csp_Demo',
      ext: './rule.json',
    },
  ],
};

function encodeBase58(text: string): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = Buffer.from(text, 'utf-8');
  const digits: number[] = [];
  for (const byte of Array.from(bytes)) {
    let carry = byte;
    for (let i = 0; i < digits.length; ++i) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (const byte of Array.from(bytes)) {
    if (byte === 0) digits.push(0);
    else break;
  }
  return digits
    .reverse()
    .map((d) => ALPHABET[d])
    .join('');
}

function jsonHandler(
  routes: Record<string, { body?: string; status?: number }>
): Handler {
  return (req, res) => {
    const route = routes[req.url || ''] || {
      status: 404,
      body: 'not found',
    };
    res.writeHead(route.status || 200, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(route.body || '');
  };
}

describe('批量订阅拉取与合并', () => {
  let configServer: { baseUrl: string; close: () => Promise<void> };
  let storeServer: { baseUrl: string; close: () => Promise<void> };

  beforeAll(async () => {
    configServer = await startServer(
      jsonHandler({
        '/cfg.json': { body: JSON.stringify(tvBoxConfig) },
        '/api.php/provide/vod': { body: '{"list":[]}' },
      })
    );
    const storeHouse = {
      urls: [
        { name: '子订阅甲', url: `${configServer.baseUrl}/cfg.json` },
        { name: '失效子订阅', url: `${configServer.baseUrl}/missing.json` },
      ],
    };
    const base58Config = encodeBase58(
      JSON.stringify({
        api_site: {
          'cms-b': {
            name: 'CMS乙',
            api: 'https://example.org/api',
            protocol: 'cms',
          },
        },
      })
    );
    storeServer = await startServer(
      jsonHandler({
        '/store': { body: JSON.stringify(storeHouse) },
        '/base58': { body: base58Config },
      })
    );
  });

  afterAll(async () => {
    await configServer.close();
    await storeServer.close();
  });

  test('多仓一层展开 + 部分失败容错 + 多订阅合并去重', async () => {
    const { configContent, mergedUrls, failures } =
      await fetchAndMergeSubscriptions([
        `${configServer.baseUrl}/cfg.json`,
        `${storeServer.baseUrl}/store`,
        `${storeServer.baseUrl}/base58`,
        `${storeServer.baseUrl}/dead-route`,
      ]);
    expect(configContent).not.toBeNull();
    const merged = JSON.parse(configContent as string);
    // cfg.json 直连 + 多仓展开引入同一份 → 相同源去重，只保留一份
    expect(Object.keys(merged.api_site).sort()).toEqual([
      'cms-a',
      'cms-b',
      'spider-b',
    ]);
    // 相对地址按各订阅自身 URL 解析
    expect(merged.api_site['cms-a'].api).toBe(
      `${configServer.baseUrl}/api.php/provide/vod`
    );
    expect(merged.api_site['spider-b'].ext).toBe(
      `${configServer.baseUrl}/rule.json`
    );
    expect(merged.api_site['spider-b'].spider).toBe(
      `${configServer.baseUrl}/spider.jar;md5;abc`
    );
    // 合并地址去重：cfg.json 只记一次
    expect(mergedUrls.sort()).toEqual([
      `${configServer.baseUrl}/cfg.json`,
      `${storeServer.baseUrl}/base58`,
    ]);
    // 失败记录：多仓失效子项 + 顶层失效地址
    const failureUrls = failures.map((f) => f.url).sort();
    expect(failureUrls).toEqual([
      `${configServer.baseUrl}/missing.json`,
      `${storeServer.baseUrl}/dead-route`,
    ]);
  });

  test('全部失败时返回 null 并保留逐条错误', async () => {
    const { configContent, failures } = await fetchAndMergeSubscriptions([
      `${storeServer.baseUrl}/dead-route`,
      'http://127.0.0.1:1/unreachable',
    ]);
    expect(configContent).toBeNull();
    expect(failures).toHaveLength(2);
  });

  test('URL 清洗：去重、剔除非法与非 http(s) 地址', () => {
    expect(
      normalizeSubscriptionUrls([
        'http://a.com/x.json',
        ' http://a.com/x.json ',
        'ftp://b.com/y.json',
        'not-a-url',
        '',
        'https://c.com/z.json',
      ])
    ).toEqual(['http://a.com/x.json', 'https://c.com/z.json']);
    expect(normalizeSubscriptionUrls('http://a.com/x.json')).toEqual([
      'http://a.com/x.json',
    ]);
    expect(normalizeSubscriptionUrls('')).toEqual([]);
  });
});
