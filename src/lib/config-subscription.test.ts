/** @jest-environment node */
/* eslint-env jest */
import {
  normalizeConfigObject,
  parseConfigSubscription,
} from './config-subscription';

const json = JSON.stringify({
  api_site: {
    demo: { name: '测试源', api: 'https://example.com/api', detail: '' },
  },
});

test('普通 JSON 与 Base58 JSON 均处理外层和解码后的空白/BOM', async () => {
  const bs58 = (await import('bs58')).default;
  await expect(parseConfigSubscription(` \n\uFEFF${json}\n `)).resolves.toBe(
    json
  );
  const encoded = bs58.encode(Buffer.from(`\uFEFF \n${json}\n `));
  await expect(parseConfigSubscription(`\uFEFF ${encoded}\n`)).resolves.toBe(
    json
  );
  await expect(parseConfigSubscription('{}')).resolves.toBe('{}');
});

test.each([
  ['', '内容为空'],
  ['{"api_site":', '格式错误'],
  ['null', '顶层'],
  ['[]', '顶层'],
  ['123', '顶层'],
  ['"字符串"', '顶层'],
  ['{"api_site":[]}', 'api_site 必须是对象'],
  ['{"api_site":null}', 'api_site 必须是对象'],
  ['{"api_site":{"demo":null}}', 'api_site[demo]'],
  ['{"api_site":{"demo":{"name":"源","api":1}}}', 'api_site[demo]'],
  ['{"api_site":{"demo":{"name":" ","api":"api"}}}', 'api_site[demo]'],
  [
    '{"api_site":{"demo":{"name":"源","api":"api","detail":false}}}',
    'api_site[demo]',
  ],
])('无效订阅 %s 返回清楚错误', async (content, message) => {
  await expect(parseConfigSubscription(content)).rejects.toThrow(message);
});

test('TVBox 归一识别协议、保留解析元数据并解析订阅相对地址', async () => {
  const config = {
    spider: './spider.jar;md5;123',
    parses: [{ name: '解析', url: 'https://example.com/parse?url=' }],
    sites: [
      { key: 'cms', name: 'CMS', type: 1, api: './api' },
      {
        key: 'js',
        name: '猫源',
        type: 2,
        api: './cat.js;md5;abc',
        ext: { file: './rule.json', token: 'abc' },
      },
      { key: 'csp', name: '爬虫', type: 3, api: 'csp_Demo', ext: './data.txt' },
    ],
  };
  const normalized = JSON.parse(
    await parseConfigSubscription(
      JSON.stringify(config),
      'https://example.com/sub/config.json'
    )
  );
  expect(normalized.parses).toEqual(config.parses);
  expect(normalized.api_site.cms).toMatchObject({
    protocol: 'cms',
    api: 'https://example.com/sub/api',
    siteType: 1,
  });
  expect(normalized.api_site.js).toMatchObject({
    protocol: 'catjs',
    api: 'https://example.com/sub/cat.js;md5;abc',
    ext: { file: 'https://example.com/sub/rule.json', token: 'abc' },
  });
  expect(normalized.api_site.csp).toMatchObject({
    protocol: 'csp',
    api: 'csp_Demo',
    spider: 'https://example.com/sub/spider.jar;md5;123',
    ext: 'https://example.com/sub/data.txt',
    runnerSite: 'csp',
  });
  expect(normalizeConfigObject(normalized)).toEqual(normalized);
  const bs58 = (await import('bs58')).default;
  expect(
    JSON.parse(
      await parseConfigSubscription(
        bs58.encode(Buffer.from(JSON.stringify(config))),
        'https://example.com/sub/config.json'
      )
    )
  ).toEqual(normalized);
});

test('JS优先于type3，XML和聚合源明确标为未支持', async () => {
  const config = JSON.parse(
    await parseConfigSubscription(
      JSON.stringify({
        sites: [
          { key: 'js3', name: 'JS', type: 3, api: './demo.js' },
          { key: 'xml', name: 'XML', type: 0, api: 'https://example.com/xml' },
          {
            key: 'aggregate',
            name: '聚合',
            type: 4,
            api: 'https://example.com/aggregate',
          },
        ],
      })
    )
  );
  expect(config.api_site.js3.protocol).toBe('catjs');
  expect(config.api_site.xml).toMatchObject({
    siteType: 0,
    runtimeStatus: 'unsupported',
  });
  expect(config.api_site.aggregate).toMatchObject({
    siteType: 4,
    runtimeStatus: 'unsupported',
  });
});

test.each(['bad+key', 'bad\u0001key', ' '])(
  '原生和TVBox拒绝无效源键 %s',
  async (key) => {
    await expect(
      parseConfigSubscription(
        JSON.stringify({ api_site: { [key]: { name: '源', api: 'api' } } })
      )
    ).rejects.toThrow();
    await expect(
      parseConfigSubscription(
        JSON.stringify({ sites: [{ key, name: '源', api: 'api' }] })
      )
    ).rejects.toThrow();
  }
);

test.each([
  { protocol: 'unknown' },
  { runnerSite: 1 },
  { spider: {} },
  { siteType: '3' },
  { runtimeStatus: false },
])('拒绝无效协议字段 %s', async (fields) => {
  await expect(
    parseConfigSubscription(
      JSON.stringify({
        api_site: { demo: { name: '源', api: 'api', ...fields } },
      })
    )
  ).rejects.toThrow();
});

test('Base58 解码后同样校验 UTF-8、JSON 语法和配置结构', async () => {
  const bs58 = (await import('bs58')).default;
  for (const [content, message] of [
    ['not json', '解码后不是有效 JSON'],
    ['[]', '顶层'],
    ['{"api_site":[]}', 'api_site 必须是对象'],
  ]) {
    await expect(
      parseConfigSubscription(bs58.encode(Buffer.from(content)))
    ).rejects.toThrow(message);
  }
  await expect(
    parseConfigSubscription(bs58.encode(Uint8Array.from([255])))
  ).rejects.toThrow('解码失败');
});
