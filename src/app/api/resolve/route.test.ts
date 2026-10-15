/** @jest-environment node */
/* eslint-env jest */
jest.mock('next/server', () => ({
  NextResponse: {
    json: (
      body: unknown,
      options: { status?: number; headers?: unknown } = {}
    ) => ({ body, status: options.status || 200, headers: options.headers }),
  },
}));
jest.mock('@/lib/downstream', () => ({ getDetailFromApi: jest.fn() }));
jest.mock('@/lib/auth', () => ({ getAuthInfoFromCookie: jest.fn() }));
jest.mock('@/lib/config', () => ({ getAvailableApiSites: jest.fn() }));
jest.mock('@/lib/source-media', () => ({
  assertPublicMediaUrl: jest.fn(),
  createMediaUrl: jest.fn(),
  normalizeMediaHeaders: () => ({}),
}));
jest.mock('@/lib/source-runner', () => ({
  ...jest.requireActual('@/lib/source-runner'),
  callSourceRunner: jest.fn(),
}));
import { NextRequest } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';
import { callSourceRunner } from '@/lib/source-runner';

import { POST } from './route';

const request = (body: unknown) =>
  ({
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest);
const auth = getAuthInfoFromCookie as jest.Mock;
const sites = getAvailableApiSites as jest.Mock;
const runner = callSourceRunner as jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  auth.mockReturnValue({ username: 'alice' });
  sites.mockResolvedValue([{ key: 'cat', protocol: 'catjs' }]);
  (getDetailFromApi as jest.Mock).mockResolvedValue({
    playLines: [{ name: '线路1', episodes: ['/opaque+a'] }],
  });
});
it('未登录请求返回private no-store且不访问源', async () => {
  auth.mockReturnValue(null);
  const response = await POST(request({ source: 'cat', id: '/a+b' }));
  expect(response.status).toBe(401);
  expect(response.headers).toEqual({ 'Cache-Control': 'private, no-store' });
  expect(runner).not.toHaveBeenCalled();
});
it('拒绝用户无权访问的来源', async () => {
  sites.mockResolvedValue([]);
  expect(
    (await POST(request({ source: 'cat', videoId: 'v1', id: 'opaque' }))).status
  ).toBe(403);
  expect(sites).toHaveBeenCalledWith('alice');
  expect(runner).not.toHaveBeenCalled();
});
it('拒绝缺失视频ID以及详情中不存在的集数或线路', async () => {
  expect(
    (await POST(request({ source: 'cat', id: '/opaque+a', flag: '线路1' })))
      .status
  ).toBe(400);
  for (const body of [
    {
      source: 'cat',
      videoId: 'v1',
      id: 'https://evil.example/a',
      flag: '线路1',
    },
    { source: 'cat', videoId: 'v1', id: '/opaque+a', flag: '伪造线路' },
  ])
    expect((await POST(request(body))).status).toBe(403);
  expect(runner).not.toHaveBeenCalled();
});
it('返回显式媒体类型并使用不超过上游的毫秒有效期', async () => {
  const expiresAt = Date.now() + 60000;
  runner.mockResolvedValue({
    parse: 0,
    type: 'hls',
    url: 'https://media.example/opaque',
    expiresAt,
  });
  const response = await POST(
    request({ source: 'cat', videoId: 'v1', id: '/opaque+a', flag: '线路1' })
  );
  expect(response).toMatchObject({
    status: 200,
    body: { type: 'hls', expiresAt },
  });
  expect(getDetailFromApi).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'cat' }),
    'v1'
  );
});
it('缺省票据为4小时且拒绝秒级或过期上游有效期', async () => {
  const body = { source: 'cat', videoId: 'v1', id: '/opaque+a', flag: '线路1' };
  const now = Date.now();
  runner.mockResolvedValue({ parse: 0, url: 'https://media.example/a.mp4' });
  const response = await POST(request(body));
  const expiresAt = (response as unknown as { body: { expiresAt: number } })
    .body.expiresAt;
  expect(expiresAt).toBeGreaterThanOrEqual(now + 4 * 60 * 60 * 1000);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 4 * 60 * 60 * 1000);
  runner.mockResolvedValue({
    parse: 0,
    url: 'https://media.example/a.mp4',
    expiresAt: Math.floor(now / 1000) + 60,
  });
  expect((await POST(request(body))).status).toBe(400);
});
it('parse1明确返回unsupported且不声称播放成功', async () => {
  runner.mockResolvedValue({ parse: 1, url: 'https://media.example/a' });
  const response = await POST(
    request({ source: 'cat', videoId: 'v1', id: '/opaque+a', flag: '线路1' })
  );
  expect(response.status).toBe(422);
  expect(response).toMatchObject({ body: { code: 'UNSUPPORTED_PARSE' } });
  expect(runner).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'cat' }),
    'play',
    { id: '/opaque+a', flag: '线路1' }
  );
});
