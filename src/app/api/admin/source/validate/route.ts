/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig, getSourceRuntimeStatus } from '@/lib/config';
import { searchFromApiStrict } from '@/lib/downstream';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const config = await getConfig();
  if (authInfo.username !== process.env.USERNAME) {
    const user = config.UserConfig.Users.find(
      (entry) => entry.username === authInfo.username
    );
    if (!user || user.role !== 'admin' || user.banned) {
      return NextResponse.json({ error: '权限不足' }, { status: 401 });
    }
  }
  const searchKeyword = new URL(request.url).searchParams.get('q');
  if (!searchKeyword?.trim()) {
    return NextResponse.json({ error: '搜索关键词不能为空' }, { status: 400 });
  }

  const apiSites = config.SourceConfig;
  let streamClosed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        if (streamClosed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          streamClosed = true;
        }
      };
      send({ type: 'start', totalSources: apiSites.length });
      let completedSources = 0;
      await Promise.allSettled(
        apiSites.map(async (site) => {
          try {
            const runtimeStatus = getSourceRuntimeStatus(site);
            if (
              runtimeStatus === 'runtime_unconfigured' ||
              runtimeStatus === 'unsupported'
            ) {
              send({
                type: 'source_result',
                source: site.key,
                status: runtimeStatus,
              });
              return;
            }
            const results = await searchFromApiStrict(site, searchKeyword);
            const status = results.some((item) =>
              item.title.toLowerCase().includes(searchKeyword.toLowerCase())
            )
              ? 'valid'
              : 'no_results';
            send({ type: 'source_result', source: site.key, status });
          } catch (error) {
            console.warn(`验证失败 ${site.name}:`, error);
            send({ type: 'source_error', source: site.key, status: 'invalid' });
          } finally {
            completedSources++;
          }
        })
      );
      send({ type: 'complete', completedSources });
      if (!streamClosed) {
        streamClosed = true;
        controller.close();
      }
    },
    cancel() {
      streamClosed = true;
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'private, no-store',
      Connection: 'keep-alive',
    },
  });
}
