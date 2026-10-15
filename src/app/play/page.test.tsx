/* eslint-env jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';

import { ensureDetail, resolveVideo } from '@/lib/resolveVideo';
import type { SearchResult } from '@/lib/types';

import PlayPage from './page';

const mockPause = jest.fn();
const mockPlay = jest.fn();
const mockPlayer = jest.fn();
jest.mock('artplayer', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options) => {
    mockPlayer(options);
    return {
      option: options,
      video: document.createElement('video'),
      on: jest.fn(),
      destroy: jest.fn(),
      pause: mockPause,
      play: mockPlay,
      currentTime: 12,
      paused: false,
    };
  }),
}));
jest.mock('hls.js', () => ({
  __esModule: true,
  default: class {
    static DefaultConfig: { loader: new () => object } = { loader: class {} };
  },
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useSearchParams: () => new URLSearchParams('source=a&id=a&title=测试'),
}));
jest.mock('@/lib/resolveVideo', () => ({
  ensureDetail: jest.fn(),
  resolveVideo: jest.fn(),
  getMediaType: () => 'movie',
  getDefaultPlayLine: (source: SearchResult) => source.playLines?.[0]?.name,
}));
jest.mock('@/lib/utils', () => ({ processImageUrl: (url: string) => url }));
jest.mock('@/lib/db.client', () => ({
  getAllPlayRecords: async () => ({}),
  getSkipConfig: async () => null,
  isFavorited: async () => false,
  subscribeToDataUpdates: () => () => undefined,
  generateStorageKey: (source: string, id: string) => `${source}+${id}`,
  saveSkipConfig: async () => undefined,
}));
jest.mock('@/components/PageLayout', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('@/components/EpisodeSelector', () => ({
  __esModule: true,
  default: ({ onSourceChange }: any) => (
    <div>
      <button onClick={() => onSourceChange('a', 'a', '测试')}>源A</button>
      <button onClick={() => onSourceChange('b', 'b', '测试')}>源B</button>
    </div>
  ),
}));

const sourceA: SearchResult = {
  source: 'a',
  id: 'a',
  title: '测试',
  year: '2026',
  poster: '',
  source_name: '源A',
  episodes: ['原始A'],
  episodes_titles: ['正片'],
};
const sourceB: SearchResult = {
  ...sourceA,
  source: 'b',
  id: 'b',
  source_name: '源B',
};
const originalFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('enableOptimization', 'false');
  global.fetch = jest.fn(
    async (url) =>
      ({
        ok: true,
        json: async () =>
          String(url).startsWith('/api/detail')
            ? sourceA
            : { results: [sourceA, sourceB] },
      } as Response)
  );
  (ensureDetail as jest.Mock).mockImplementation(async (source) => {
    if (source.source === 'b') throw new Error('B详情500');
    return source;
  });
  (resolveVideo as jest.Mock).mockResolvedValue({
    url: 'http://localhost/api/media?a',
    type: 'hls',
    urls: [
      { name: '高清', url: 'http://localhost/api/media?a', type: 'hls' },
      { name: '标清', url: 'http://localhost/api/media?b', type: 'mp4' },
    ],
  });
});
afterEach(() => {
  global.fetch = originalFetch;
  localStorage.clear();
});

test('换源详情失败保留播放器与旧地址，并能点击当前源重试', async () => {
  render(<PlayPage />);
  await screen.findByText('源B', {}, { timeout: 3000 });
  await waitFor(() => expect(mockPlayer).toHaveBeenCalledTimes(1));
  expect(mockPlayer.mock.calls[0][0].type).toBe('m3u8');
  fireEvent.click(screen.getByText('源B'));
  await screen.findByText('B详情500');
  expect(mockPause).not.toHaveBeenCalled();
  expect(mockPlayer).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '源A' }));
  await waitFor(() => expect(resolveVideo).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('B详情500')).not.toBeInTheDocument();
  expect(mockPlay).toHaveBeenCalled();
});

test('当前源首次解析无地址时仍能点击当前源重试', async () => {
  (resolveVideo as jest.Mock).mockRejectedValueOnce(
    new Error('解析结果缺少播放地址')
  );
  render(<PlayPage />);
  await screen.findByText('解析结果缺少播放地址', {}, { timeout: 3000 });
  expect(mockPlayer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '源A' }));
  await waitFor(() => expect(mockPlayer).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('解析结果缺少播放地址')).not.toBeInTheDocument();
});

test('取消慢详情请求后迟到响应不能覆盖当前源', async () => {
  let completeDetail: ((source: SearchResult) => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  (ensureDetail as jest.Mock).mockImplementation((source, signal) => {
    if (source.source !== 'b') return Promise.resolve(source);
    requestSignal = signal;
    return new Promise<SearchResult>((resolve) => {
      completeDetail = resolve;
    });
  });
  render(<PlayPage />);
  await screen.findByText('源B', {}, { timeout: 3000 });
  fireEvent.click(screen.getByText('源B'));
  await waitFor(() => expect(requestSignal).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: '源A' }));
  expect(requestSignal?.aborted).toBe(true);
  await act(async () => {
    completeDetail?.(sourceB);
  });
  expect(resolveVideo).toHaveBeenCalledTimes(1);
  expect(mockPause).not.toHaveBeenCalled();
});

test('多清晰度选项可选择MP4，不强制使用HLS', async () => {
  render(<PlayPage />);
  const choices = await screen.findByLabelText('清晰度', {}, { timeout: 3000 });
  await waitFor(() => expect(mockPlayer).toHaveBeenCalledTimes(1));
  fireEvent.change(choices, {
    target: { value: 'http://localhost/api/media?b' },
  });
  expect(mockPlayer.mock.calls[0][0].type).toBe('mp4');
});
