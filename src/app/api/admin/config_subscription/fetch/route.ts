/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  fetchAndMergeSubscriptions,
  normalizeSubscriptionUrls,
} from '@/lib/subscription-remote';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    // 权限检查：仅站长可以拉取配置订阅
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (authInfo.username !== process.env.USERNAME) {
      return NextResponse.json(
        { error: '权限不足，只有站长可以拉取配置订阅' },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const urls = normalizeSubscriptionUrls(
      Array.isArray(body?.urls) ? body.urls : body?.url
    );

    if (urls.length === 0) {
      return NextResponse.json({ error: '缺少有效的订阅URL' }, { status: 400 });
    }

    // 批量拉取：单个失败不阻断其余；多仓格式自动展开一层
    const { configContent, mergedUrls, failures } =
      await fetchAndMergeSubscriptions(urls);

    if (configContent === null) {
      return NextResponse.json(
        {
          error: `全部订阅拉取失败（${failures.length} 个）`,
          failures,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      configContent,
      mergedUrls,
      failures,
      message:
        failures.length > 0
          ? `配置拉取成功：${mergedUrls.length} 个订阅已合并，${failures.length} 个失败`
          : '配置拉取成功',
    });
  } catch (error) {
    console.error('拉取配置失败:', error);
    return NextResponse.json({ error: '拉取配置失败' }, { status: 500 });
  }
}
