/** @jest-environment node */
import {
  createMediaUrl,
  MediaGrant,
  readMediaToken,
  rewriteHls,
  validateMediaUrl,
} from '@/lib/source-media';

const grant: MediaGrant = {
  url: 'https://media.example/main.m3u8',
  headers: { Cookie: 'session=private', Referer: 'https://player.example' },
  user: 'viewer',
  source: 'cat',
  expires: Date.now() + 60000,
};

beforeEach(() => {
  process.env.SOURCE_MEDIA_SECRET = 'test-only-media-secret';
});

afterEach(() => {
  delete process.env.SOURCE_MEDIA_SECRET;
});

test.each([
  'http://127.0.0.1/video',
  'http://192.0.2.1/video',
  'http://198.51.100.1/video',
  'http://203.0.113.1/video',
  'http://[2002:7f00:1::1]/video',
  'http://[2001:db8::1]/video',
  'http://[2001::1]/video',
  'http://user:password@media.example/video',
])('rejects nonpublic or credentialed media address %s', (url) => {
  expect(() => validateMediaUrl(url)).toThrow();
});

test('accepts public IPv4 and IPv6 addresses', () => {
  expect(validateMediaUrl('https://8.8.8.8/video').hostname).toBe('8.8.8.8');
  expect(
    validateMediaUrl('https://[2606:4700:4700::1111]/video').protocol
  ).toBe('https:');
});

test('rewrites HLS segments and keys with scoped encrypted grants', () => {
  const output = rewriteHls(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key"\nsegment.ts',
    grant.url,
    grant
  );
  const key = output.match(/URI="\/api\/media\?token=([^"]+)"/)?.[1];
  const segment = output.split('\n')[2].split('token=')[1];
  expect(key).toBeDefined();
  const keyGrant = readMediaToken(key || '');
  expect(keyGrant.headers.Cookie).toBeUndefined();
  expect(keyGrant.headers.Referer).toBe(grant.headers.Referer);
  expect(readMediaToken(segment)).toMatchObject({
    url: 'https://media.example/segment.ts',
    user: grant.user,
    source: grant.source,
    expires: grant.expires,
    headers: grant.headers,
  });
});

test('rejects unsupported inline key schemes explicitly', () => {
  expect(() =>
    rewriteHls('#EXT-X-KEY:URI="data:text/plain,key"', grant.url, grant)
  ).toThrow();
});

test('encrypted grants reject tampering and expired tokens', () => {
  const token = createMediaUrl(grant).split('token=')[1];
  const altered = Buffer.from(token, 'base64url');
  altered[altered.length - 1] ^= 1;
  expect(() => readMediaToken(altered.toString('base64url'))).toThrow();
  const expired = createMediaUrl({
    ...grant,
    expires: Date.now() - 1000,
  }).split('token=')[1];
  expect(() => readMediaToken(expired)).toThrow('媒体令牌已过期');
});
