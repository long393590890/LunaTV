/** @jest-environment node */
/* eslint-env jest */
import { parseConfigSubscription } from './config-subscription';

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
