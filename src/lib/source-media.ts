/* eslint-disable no-control-regex */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import { lookup } from 'dns/promises';
import http from 'http';
import https from 'https';
import { isIP } from 'net';

function tokenKey(): Buffer {
  const secret =
    process.env.SOURCE_MEDIA_SECRET || process.env.SOURCE_RUNNER_TOKEN;
  if (!secret)
    throw new Error(
      '媒体代理未配置 SOURCE_MEDIA_SECRET 或 SOURCE_RUNNER_TOKEN'
    );
  return createHash('sha256').update(secret).digest();
}
export interface MediaGrant {
  url: string;
  headers: Record<string, string>;
  user: string;
  source: string;
  expires: number;
  playlist?: boolean;
}

export function createMediaUrl(grant: MediaGrant): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(grant), 'utf8'),
    cipher.final(),
  ]);
  return `/api/media?token=${Buffer.concat([
    iv,
    cipher.getAuthTag(),
    encrypted,
  ]).toString('base64url')}`;
}

export function readMediaToken(token: string): MediaGrant {
  if (token.length > 32768) throw new Error('无效的媒体令牌');
  const raw = Buffer.from(token, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    tokenKey(),
    raw.subarray(0, 12)
  );
  decipher.setAuthTag(raw.subarray(12, 28));
  const grant = JSON.parse(
    Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString('utf8')
  );
  if (!grant || typeof grant.expires !== 'number' || grant.expires < Date.now())
    throw new Error('媒体令牌已过期');
  return grant;
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // 仅接受全球单播IPv6，排除文档、特殊用途及6to4隧道地址。
  const normalized = address.toLowerCase();
  const parts = normalized.split(':');
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/.test(normalized) &&
    parts[0] !== '2002' &&
    !(parts[0] === '2001' && parseInt(parts[1] || '0', 16) < 0x200) &&
    !normalized.startsWith('2001:db8:')
  );
}

export function validateMediaUrl(value: string): URL {
  if (!value || /\s/.test(value)) throw new Error('媒体地址无效');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port))
  )
    throw new Error('媒体地址协议或端口不受支持');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    /\.(localhost|local|internal)$/.test(host) ||
    (isIP(host) && !publicAddress(host))
  )
    throw new Error('运行器返回内网媒体地址；请由运行器代理为公开HTTP(S)地址');
  return url;
}

export async function assertPublicMediaUrl(value: string): Promise<void> {
  const url = validateMediaUrl(value);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), {
    all: true,
  });
  if (
    !addresses.length ||
    addresses.some((entry) => !publicAddress(entry.address))
  )
    throw new Error('媒体地址指向内网或保留网络');
}

export function normalizeMediaHeaders(value: unknown): Record<string, string> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('媒体请求头格式无效');
    }
  }
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('媒体请求头格式无效');
  const result: Record<string, string> = {};
  for (const [name, content] of Object.entries(value)) {
    if (
      !/^(user-agent|referer|origin|cookie|authorization|accept|accept-language|x-[\w-]+)$/i.test(
        name
      ) ||
      typeof content !== 'string' ||
      /[\r\n\x00]/.test(content) ||
      content.length > 8192
    )
      throw new Error('媒体请求头不受支持');
    result[name] = content;
  }
  return result;
}

export async function requestPublicMedia(
  raw: string,
  headers: Record<string, string>,
  redirects = 0
): Promise<http.IncomingMessage> {
  const url = validateMediaUrl(raw);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), {
    all: true,
  });
  if (
    !addresses.length ||
    addresses.some((entry) => !publicAddress(entry.address))
  )
    throw new Error('禁止访问内网媒体地址');
  const chosen = addresses[0];
  const response = await new Promise<http.IncomingMessage>(
    (resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(
        url,
        {
          headers,
          lookup: (_hostname, _options, callback) =>
            callback(null, chosen.address, chosen.family),
        },
        resolve
      );
      request.setTimeout(20000, () =>
        request.destroy(new Error('媒体请求超时'))
      );
      request.on('error', reject);
    }
  );
  if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
    response.resume();
    if (redirects >= 3 || !response.headers.location)
      throw new Error('媒体重定向无效');
    const target = new URL(response.headers.location, url);
    // 跨域跳转不能携带上游凭据。
    const nextHeaders = { ...headers };
    if (target.origin !== url.origin) {
      Object.keys(nextHeaders).forEach((name) => {
        if (/^(cookie|authorization)$/i.test(name)) delete nextHeaders[name];
      });
    }
    return requestPublicMedia(target.href, nextHeaders, redirects + 1);
  }
  Object.assign(response, { mediaUrl: url.href, mediaHeaders: headers });
  return response;
}

export function rewriteHls(
  text: string,
  base: string,
  grant: MediaGrant
): string {
  const proxy = (uri: string) => {
    const target = new URL(uri, base);
    validateMediaUrl(target.href);
    const headers = { ...grant.headers };
    Object.keys(headers).forEach((name) => {
      if (/^range$/i.test(name)) delete headers[name];
    });
    if (target.origin !== new URL(base).origin) {
      Object.keys(headers).forEach((name) => {
        if (/^(cookie|authorization)$/i.test(name)) delete headers[name];
      });
    }
    return createMediaUrl({
      ...grant,
      headers,
      url: target.href,
      playlist: undefined,
    });
  };
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      if (!line.startsWith('#')) return proxy(line.trim());
      return line.replace(
        /URI="([^"]+)"/g,
        (_match, uri: string) => `URI="${proxy(uri)}"`
      );
    })
    .join('\n');
}
