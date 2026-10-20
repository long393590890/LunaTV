/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getIptvOrgM3u } from '@/lib/iptvorg';

export const runtime = 'nodejs';

// iptv-org 公共源 m3u 生成接口：
//   /api/iptvorg/m3u                       全部频道（默认 2000 条上限）
//   /api/iptvorg/m3u?country=cn,hk         按国家过滤（ISO 3166-1 alpha-2）
//   /api/iptvorg/m3u?category=news,music   按分类过滤
//   /api/iptvorg/m3u?https=1               仅 https 流
//   /api/iptvorg/m3u?limit=500             数量上限（<=10000）
// 该 URL 可直接作为管理后台「直播源」的 M3U 地址使用。

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400',
};

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const countries = searchParams.get('country') || '';
    const categories = searchParams.get('category') || '';
    const httpsOnly = searchParams.get('https') === '1';
    const limitParam = parseInt(searchParams.get('limit') || '', 10);
    const forceRefresh = searchParams.get('refresh') === '1';

    const m3u = await getIptvOrgM3u({
      countries: countries ? countries.split(',') : undefined,
      categories: categories ? categories.split(',') : undefined,
      httpsOnly,
      limit: Number.isFinite(limitParam) ? limitParam : undefined,
      forceRefresh,
    });

    if (!m3u.includes('\n')) {
      return NextResponse.json(
        { error: '没有匹配的频道：请检查 country/category 过滤条件' },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    return new NextResponse(m3u, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      },
    });
  } catch (error) {
    console.error('iptv-org m3u 生成失败:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'iptv-org 数据拉取失败',
      },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
