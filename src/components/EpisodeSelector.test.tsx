/* eslint-env jest */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { VideoInfo } from '@/lib/source-list';
import type { SearchResult } from '@/lib/types';

import EpisodeSelector from './EpisodeSelector';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('@/lib/utils', () => ({
  processImageUrl: (url: string) => url,
  getVideoResolutionFromM3u8: jest.fn(),
}));

const sources: SearchResult[] = ['Alpha', 'Beta'].map((source_name, index) => ({
  source: String(index),
  id: '1',
  source_name,
  title: `影片${index}`,
  poster: '',
  episodes: ['episode'],
  episodes_titles: ['正片'],
  year: '2026',
}));
const info = new Map<string, VideoInfo>([
  [
    '0-1',
    { quality: '720p', loadSpeed: '1 MB/s', loadSpeedKBps: 1024, pingTime: 20 },
  ],
  [
    '1-1',
    {
      quality: '720p',
      loadSpeed: '2 MB/s',
      loadSpeedKBps: 2048,
      pingTime: 100,
    },
  ],
]);

test('显式允许错误恢复时可以点击当前源重试', () => {
  localStorage.setItem('enableOptimization', 'false');
  const onSourceChange = jest.fn();
  render(
    <EpisodeSelector
      totalEpisodes={1}
      episodes_titles={['正片']}
      availableSources={sources}
      currentSource='0'
      currentId='1'
      allowCurrentSourceRetry
      onSourceChange={onSourceChange}
    />
  );
  fireEvent.click(screen.getByText('Alpha'));
  expect(onSourceChange).toHaveBeenCalledWith('0', '1', '影片0');
});

test('搜索和切换排序只改变显示列表，当前源保持选择', () => {
  localStorage.setItem('enableOptimization', 'false');
  const onSourceChange = jest.fn();
  const { container } = render(
    <EpisodeSelector
      totalEpisodes={1}
      episodes_titles={['正片']}
      availableSources={sources}
      currentSource='0'
      currentId='1'
      precomputedVideoInfo={info}
      onSourceChange={onSourceChange}
    />
  );
  const titles = () =>
    Array.from(container.querySelectorAll('h3')).map(
      (node) => node.textContent
    );
  expect(titles()).toEqual(['影片1', '影片0']);
  fireEvent.click(screen.getByRole('button', { name: '延迟' }));
  expect(titles()).toEqual(['影片0', '影片1']);
  fireEvent.click(screen.getByRole('button', { name: '延迟 ↑' }));
  expect(titles()).toEqual(['影片1', '影片0']);
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: ' beta ' },
  });
  expect(titles()).toEqual(['影片1']);
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'missing' },
  });
  expect(screen.getByRole('status')).toHaveTextContent('没有匹配的源名称');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.click(screen.getByText('Alpha'));
  expect(onSourceChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Beta'));
  expect(onSourceChange).toHaveBeenCalledWith('1', '1', '影片1');
});
