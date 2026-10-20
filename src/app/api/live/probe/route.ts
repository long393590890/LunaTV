import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// 直播流可用性探测：
// 服务端分别以「默认 UA（不带声明头）」和「m3u 声明的 UA/Referer」请求 m3u8 索引，
// 对比状态码得出结论，供前端提示用户该流在网页端能否直接播放。
// 只拉取索引文件（几 KB），不下载视频分片。仅限 http(s)，8s 超时。

const DEFAULT_UA = 'AptvPlayer/1.4.10';
const PROBE_TIMEOUT_MS = 8_000;

type Verdict = 'ok' | 'headers_required' | 'dead';

interface ProbeOutcome {
  verdict: Verdict;
  statusWithout: number | null;
  statusWith: number | null;
}

async function probeOnce(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
    });
    // 读一小段确认可读即丢弃（有些服务器 200 但连接挂起）
    const reader = response.body?.getReader();
    if (reader) {
      await reader.read();
      reader.cancel().catch(() => null);
    }
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url') || '';
    const declaredUa = searchParams.get('ua') || '';
    const declaredReferer = searchParams.get('referer') || '';

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return NextResponse.json({ error: '无效的流地址' }, { status: 400 });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return NextResponse.json(
        { error: '仅支持 http(s) 地址' },
        { status: 400 }
      );
    }

    // 1) 不带声明头（模拟网页直连环境，LunaTV 默认播放 UA）
    const without = await probeOnce(url, { 'User-Agent': DEFAULT_UA });

    // 2) 带 m3u 声明的 UA/Referer（若提供了）
    if (!without.ok && (declaredUa || declaredReferer)) {
      const headers: Record<string, string> = {};
      if (declaredUa) headers['User-Agent'] = declaredUa;
      if (declaredReferer) headers.Referer = declaredReferer;
      const withHeaders = await probeOnce(url, headers);

      const outcome: ProbeOutcome = withHeaders.ok
        ? {
            verdict: 'headers_required',
            statusWithout: without.status,
            statusWith: withHeaders.status,
          }
        : {
            verdict: 'dead',
            statusWithout: without.status,
            statusWith: withHeaders.status,
          };
      return NextResponse.json({ success: true, ...outcome });
    }

    const outcome: ProbeOutcome = without.ok
      ? { verdict: 'ok', statusWithout: without.status, statusWith: null }
      : { verdict: 'dead', statusWithout: without.status, statusWith: null };
    return NextResponse.json({ success: true, ...outcome });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '探测失败' },
      { status: 500 }
    );
  }
}
