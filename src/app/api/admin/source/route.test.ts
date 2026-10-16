/** @jest-environment node */
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, options: { status?: number } = {}) => ({
      body,
      status: options.status || 200,
    }),
  },
}));
jest.mock('@/lib/auth', () => ({ getAuthInfoFromCookie: jest.fn() }));
jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
  getSourceRuntimeStatus: jest.fn(),
}));
jest.mock('@/lib/db', () => ({ db: { saveAdminConfig: jest.fn() } }));
import { NextRequest } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';

import { POST } from './route';

const request = (body: unknown) => ({ json: async () => body } as NextRequest);
let config: {
  SourceConfig: Array<{ key: string; from: string; featured?: boolean }>;
  UserConfig: { Users: unknown[] };
};
const originalEnv = {
  storage: process.env.NEXT_PUBLIC_STORAGE_TYPE,
  username: process.env.USERNAME,
};
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';
  process.env.USERNAME = 'owner';
  (getAuthInfoFromCookie as jest.Mock).mockReturnValue({ username: 'owner' });
  config = {
    SourceConfig: [
      { key: 'a', from: 'custom' },
      { key: 'b', from: 'config' },
    ],
    UserConfig: { Users: [] },
  };
  (getConfig as jest.Mock).mockResolvedValue(config);
});
afterAll(() => {
  for (const [key, value] of Object.entries({
    NEXT_PUBLIC_STORAGE_TYPE: originalEnv.storage,
    USERNAME: originalEnv.username,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
test('精选只标记既有视频源且支持配置源，重复key不产生副本', async () => {
  const response = await POST(
    request({ action: 'batch_feature', keys: ['a', 'b', 'a'] })
  );
  expect(response.status).toBe(200);
  expect(config.SourceConfig).toHaveLength(2);
  expect(config.SourceConfig.every((source) => source.featured)).toBe(true);
  expect(db.saveAdminConfig).toHaveBeenCalledWith(config);
});
test('取消精选保留原视频源', async () => {
  config.SourceConfig[0].featured = true;
  await POST(request({ action: 'batch_unfeature', keys: ['a'] }));
  expect(config.SourceConfig[0].featured).toBe(false);
  expect(config.SourceConfig).toHaveLength(2);
});
test.each([[], [null], 'a'])('无效keys不保存配置 %j', async (keys) => {
  const response = await POST(request({ action: 'batch_feature', keys }));
  expect(response.status).toBe(400);
  expect(db.saveAdminConfig).not.toHaveBeenCalled();
});
test('未知key整批拒绝，已存在源也不修改', async () => {
  const response = await POST(
    request({ action: 'batch_feature', keys: ['a', 'missing'] })
  );
  expect(response.status).toBe(404);
  expect(config.SourceConfig[0].featured).toBeUndefined();
  expect(db.saveAdminConfig).not.toHaveBeenCalled();
});
test('普通用户不能修改精选', async () => {
  (getAuthInfoFromCookie as jest.Mock).mockReturnValue({ username: 'viewer' });
  const response = await POST(
    request({ action: 'batch_feature', keys: ['a'] })
  );
  expect(response.status).toBe(401);
  expect(db.saveAdminConfig).not.toHaveBeenCalled();
});
