/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import {
  getAuthInfoFromCookie,
  onlyFeaturedFromCookie,
  selectedSourceFromCookie,
} from '@/lib/auth';
import { getAvailableApiSites } from '@/lib/config';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };

// OrionTV 兼容接口
export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers }
    );
  }
  try {
    // 选择器需要完整的有权限视频源，忽略当前个人筛选。
    const selectMode =
      request.nextUrl.searchParams.get('scope') === 'selection';
    const apiSites = await getAvailableApiSites(
      authInfo.username,
      selectMode ? false : onlyFeaturedFromCookie(request),
      selectMode ? undefined : selectedSourceFromCookie(request)
    );

    return NextResponse.json(
      apiSites.map((site) => ({
        key: site.key,
        name: site.name,
        protocol: site.protocol || 'cms',
        ...(site.protocol === 'catjs' || site.protocol === 'csp'
          ? {}
          : { api: site.api }),
      })),
      { headers }
    );
  } catch (error) {
    return NextResponse.json(
      { error: '获取资源失败' },
      { status: 500, headers }
    );
  }
}
