import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'stream';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites } from '@/lib/config';
import {
  readMediaToken,
  requestPublicMedia,
  rewriteHls,
} from '@/lib/source-media';

export const runtime = 'nodejs';
const privateHeaders = { 'Cache-Control': 'private, no-store' };
export async function GET(request: NextRequest) {
  const auth = getAuthInfoFromCookie(request);
  if (!auth?.username)
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: privateHeaders }
    );
  try {
    const grant = readMediaToken(
      request.nextUrl.searchParams.get('token') || ''
    );
    if (
      grant.user !== auth.username ||
      !(await getAvailableApiSites(auth.username)).some(
        (site) => site.key === grant.source
      )
    )
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403, headers: privateHeaders }
      );
    const upstreamHeaders = { ...grant.headers };
    const range = request.headers.get('range');
    if (range) {
      if (!/^bytes=\d*-\d*(,\d*-\d*)*$/.test(range))
        throw new Error('无效的Range');
      upstreamHeaders.Range = range;
    }
    const upstream = await requestPublicMedia(grant.url, upstreamHeaders);
    request.signal.addEventListener('abort', () => upstream.destroy(), {
      once: true,
    });
    if (request.signal.aborted) {
      upstream.destroy();
      throw new Error('媒体请求已取消');
    }
    const status = upstream.statusCode || 502;
    if (![200, 206].includes(status)) {
      upstream.destroy();
      return NextResponse.json(
        { error: `媒体上游请求失败 (${status})` },
        { status: 502, headers: privateHeaders }
      );
    }
    const contentType = String(
      upstream.headers['content-type'] || 'application/octet-stream'
    );
    if (
      /text\/html|application\/xhtml|image\/svg|javascript/i.test(contentType)
    ) {
      upstream.destroy();
      throw new Error('上游未返回媒体内容');
    }
    const finalUrl = (upstream as typeof upstream & { mediaUrl: string })
      .mediaUrl;
    const headers = new Headers(privateHeaders);
    headers.set('Content-Type', contentType);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (
      grant.playlist ||
      /mpegurl/i.test(contentType) ||
      /\.m3u8(?:\?|$)/i.test(finalUrl)
    ) {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of upstream) {
        size += chunk.length;
        if (size > 2_000_000) {
          upstream.destroy();
          throw new Error('媒体清单过大');
        }
        chunks.push(Buffer.from(chunk));
      }
      headers.set('Content-Type', 'application/vnd.apple.mpegurl');
      return new NextResponse(
        rewriteHls(Buffer.concat(chunks).toString('utf8'), finalUrl, {
          ...grant,
          headers: (
            upstream as typeof upstream & {
              mediaHeaders: Record<string, string>;
            }
          ).mediaHeaders,
        }),
        { status, headers }
      );
    }
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const body = Readable.toWeb(upstream) as ReadableStream<Uint8Array>;
    return new NextResponse(body, { status, headers });
  } catch {
    return NextResponse.json(
      { error: '媒体请求无效、已过期或上游不可用' },
      { status: 400, headers: privateHeaders }
    );
  }
}
