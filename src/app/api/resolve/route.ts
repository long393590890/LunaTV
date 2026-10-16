import { NextRequest, NextResponse } from 'next/server';

import {
  getAuthInfoFromCookie,
  onlyFeaturedFromCookie,
  selectedSourceFromCookie,
} from '@/lib/auth';
import { getAvailableApiSites } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';
import {
  assertPublicMediaUrl,
  createMediaUrl,
  normalizeMediaHeaders,
} from '@/lib/source-media';
import {
  callSourceRunner,
  isRunnerSource,
  normalizePlayResponse,
  validOpaqueId,
} from '@/lib/source-runner';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
export async function POST(request: NextRequest) {
  const auth = getAuthInfoFromCookie(request);
  if (!auth?.username)
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers }
    );
  try {
    if (Number(request.headers.get('content-length')) > 32768)
      return NextResponse.json({ error: '请求过大' }, { status: 413, headers });
    const body = await request.json();
    if (
      !validOpaqueId(body.id) ||
      !validOpaqueId(body.videoId) ||
      typeof body.source !== 'string' ||
      (body.flag !== undefined &&
        (!validOpaqueId(body.flag) || body.flag.length > 512))
    )
      return NextResponse.json(
        { error: '播放参数无效' },
        { status: 400, headers }
      );
    const site = (
      await getAvailableApiSites(
        auth.username,
        onlyFeaturedFromCookie(request),
        selectedSourceFromCookie(request)
      )
    ).find((entry) => entry.key === body.source);
    if (!site)
      return NextResponse.json(
        { error: '无效的API来源' },
        { status: 403, headers }
      );
    const detail = await getDetailFromApi(site, body.videoId);
    const member = detail.playLines?.some(
      (line) => line.name === body.flag && line.episodes.includes(body.id)
    );
    if (!member)
      return NextResponse.json(
        { error: '播放地址不属于该视频线路' },
        { status: 403, headers }
      );
    const data: Record<string, unknown> = isRunnerSource(site)
      ? await callSourceRunner(site, 'play', {
          id: body.id,
          flag: body.flag || '',
        })
      : { parse: 0, url: body.id };
    const choices = normalizePlayResponse(data);
    const upstreamHeaders = normalizeMediaHeaders(data.header || data.headers);
    // expiresAt 为 Unix 毫秒时间戳，票据不得超出上游地址有效期。
    const now = Date.now();
    if (
      data.expiresAt !== undefined &&
      (typeof data.expiresAt !== 'number' ||
        !Number.isFinite(data.expiresAt) ||
        data.expiresAt <= now)
    )
      throw new Error('上游 expiresAt 必须为有效的 Unix 毫秒时间戳');
    const expires = Math.min(
      now + 4 * 60 * 60 * 1000,
      typeof data.expiresAt === 'number' ? data.expiresAt : Infinity
    );
    const username = auth.username;
    const urls = await Promise.all(
      choices.map(async (choice) => {
        await assertPublicMediaUrl(choice.url);
        return {
          name: choice.name,
          type:
            /^(hls|m3u8)$/i.test(String(data.type || '')) ||
            /\.m3u8(?:\?|$)/i.test(choice.url)
              ? 'hls'
              : /^mp4$/i.test(String(data.type || '')) ||
                /\.mp4(?:\?|$)/i.test(choice.url)
              ? 'mp4'
              : undefined,
          url: Object.keys(upstreamHeaders).length
            ? createMediaUrl({
                url: choice.url,
                headers: upstreamHeaders,
                user: username,
                source: site.key,
                expires,
                playlist:
                  /^(hls|m3u8)$/i.test(String(data.type || '')) ||
                  /\.m3u8(?:\?|$)/i.test(choice.url),
              })
            : choice.url,
        };
      })
    );
    return NextResponse.json(
      {
        parse: 0,
        url: urls[0].url,
        type: urls[0].type,
        expiresAt: expires,
        urls,
      },
      { headers }
    );
  } catch (error) {
    if ((error as Error).message === 'UNSUPPORTED_PARSE')
      return NextResponse.json(
        { error: '该源需要额外解析，当前不支持', code: 'UNSUPPORTED_PARSE' },
        { status: 422, headers }
      );
    return NextResponse.json(
      {
        error:
          error instanceof SyntaxError
            ? '请求格式无效'
            : (error as Error).message,
      },
      { status: 400, headers }
    );
  }
}
