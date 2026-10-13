function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function parseConfigSubscription(
  content: string
): Promise<string> {
  let text = content.trim();
  if (!text) throw new Error('订阅配置内容为空');

  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    // JSON 标点不属于 Base58 字母表，直接报告 JSON 语法错误。
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) {
      throw new Error(
        '订阅配置格式错误：请输入有效 JSON 或 Base58 编码的 JSON'
      );
    }
    try {
      const bs58 = (await import('bs58')).default;
      text = new TextDecoder('utf-8', { fatal: true })
        .decode(bs58.decode(text))
        .trim();
    } catch {
      throw new Error('订阅配置 Base58 解码失败：内容必须为 UTF-8 JSON');
    }
    try {
      config = JSON.parse(text);
    } catch {
      throw new Error('订阅配置 Base58 解码后不是有效 JSON');
    }
  }

  if (!isObject(config)) {
    throw new Error('订阅配置顶层必须是 JSON 对象');
  }
  if (config.api_site !== undefined) {
    if (!isObject(config.api_site)) {
      throw new Error('订阅配置 api_site 必须是对象');
    }
    for (const [key, site] of Object.entries(config.api_site)) {
      if (
        !key.trim() ||
        !isObject(site) ||
        typeof site.name !== 'string' ||
        !site.name.trim() ||
        typeof site.api !== 'string' ||
        !site.api.trim() ||
        (site.detail !== undefined && typeof site.detail !== 'string')
      ) {
        throw new Error(
          `订阅配置 api_site[${key}] 必须包含非空 name、api 字符串，detail 如提供必须为字符串`
        );
      }
    }
  }
  return text;
}
