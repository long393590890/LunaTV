import { NextRequest, NextResponse } from 'next/server';

import {
  getAuthInfoFromCookie,
  onlyFeaturedFromCookie,
  selectedSourceFromCookie,
} from '@/lib/auth';
import { getAvailableApiSites } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';
import { validOpaqueId } from '@/lib/source-runner';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username)
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers }
    );
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const source = searchParams.get('source');
  if (!validOpaqueId(id) || !source)
    return NextResponse.json(
      { error: '视频ID或来源无效' },
      { status: 400, headers }
    );
  try {
    const site = (
      await getAvailableApiSites(
        authInfo.username,
        onlyFeaturedFromCookie(request),
        selectedSourceFromCookie(request)
      )
    ).find((entry) => entry.key === source);
    if (!site)
      return NextResponse.json(
        { error: '无效的API来源' },
        { status: 400, headers }
      );
    return NextResponse.json(await getDetailFromApi(site, id), { headers });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500, headers }
    );
  }
}
