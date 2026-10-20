/* eslint-disable no-constant-condition */

import { gunzipSync } from 'node:zlib';

import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';

const defaultUA = 'AptvPlayer/1.4.10';

// 识别 gzip 魔数（0x1f 0x8b）并解压；许多 EPG 源（如 iptv-org/epg 自建输出、epg.pw）提供 .xml.gz
export function decodeEpgContent(buffer: Buffer): string {
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return gunzipSync(buffer).toString('utf-8');
  }
  return buffer.toString('utf-8');
}

export interface LiveChannels {
  channelNumber: number;
  channels: {
    id: string;
    tvgId: string;
    name: string;
    logo: string;
    group: string;
    url: string;
    // 来自 m3u 的 #EXTVLCOPT 扩展行：该流声明要求的 UA/Referer（iptv-org 等源提供）
    ua?: string;
    referer?: string;
  }[];
  epgUrl: string;
  epgs: {
    [key: string]: {
      start: string;
      end: string;
      title: string;
    }[];
  };
}

const cachedLiveChannels: { [key: string]: LiveChannels } = {};

export function deleteCachedLiveChannels(key: string) {
  delete cachedLiveChannels[key];
}

export async function getCachedLiveChannels(
  key: string
): Promise<LiveChannels | null> {
  if (!cachedLiveChannels[key]) {
    const config = await getConfig();
    const liveInfo = config.LiveConfig?.find((live) => live.key === key);
    if (!liveInfo) {
      return null;
    }
    const channelNum = await refreshLiveChannels(liveInfo);
    if (channelNum === 0) {
      return null;
    }
    liveInfo.channelNumber = channelNum;
    await db.saveAdminConfig(config);
  }
  return cachedLiveChannels[key] || null;
}

export async function refreshLiveChannels(liveInfo: {
  key: string;
  name: string;
  url: string;
  ua?: string;
  epg?: string;
  from: 'config' | 'custom';
  channelNumber?: number;
  disabled?: boolean;
}): Promise<number> {
  if (cachedLiveChannels[liveInfo.key]) {
    delete cachedLiveChannels[liveInfo.key];
  }
  const ua = liveInfo.ua || defaultUA;
  const response = await fetch(liveInfo.url, {
    headers: {
      'User-Agent': ua,
    },
  });
  const data = await response.text();
  const result = parseM3U(liveInfo.key, data);
  const epgUrl = liveInfo.epg || result.tvgUrl;
  const epgs = await parseEpg(
    epgUrl,
    liveInfo.ua || defaultUA,
    result.channels.map((channel) => channel.tvgId).filter((tvgId) => tvgId)
  );
  cachedLiveChannels[liveInfo.key] = {
    channelNumber: result.channels.length,
    channels: result.channels,
    epgUrl: epgUrl,
    epgs: epgs,
  };
  return result.channels.length;
}

async function parseEpg(
  epgUrl: string,
  ua: string,
  tvgIds: string[]
): Promise<{
  [key: string]: {
    start: string;
    end: string;
    title: string;
  }[];
}> {
  if (!epgUrl) {
    return {};
  }

  const tvgs = new Set(tvgIds);
  const result: {
    [key: string]: { start: string; end: string; title: string }[];
  } = {};

  try {
    const response = await fetch(epgUrl, {
      headers: {
        'User-Agent': ua,
      },
    });
    if (!response.ok) {
      return {};
    }

    // 一次性读取完整内容（支持 gzip，如 .xml.gz）；EPG 通常在几 MB 量级，可控
    const raw = Buffer.from(await response.arrayBuffer());
    let currentTvgId = '';
    let currentProgram: { start: string; end: string; title: string } | null =
      null;
    let shouldSkipCurrentProgram = false;

    // 逐行解析 XMLTV
    for (const line of decodeEpgContent(raw).split('\n')) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // 解析 <programme> 标签
      if (trimmedLine.startsWith('<programme')) {
        // 提取 tvg-id
        const tvgIdMatch = trimmedLine.match(/channel="([^"]*)"/);
        currentTvgId = tvgIdMatch ? tvgIdMatch[1] : '';

        // 提取开始时间
        const startMatch = trimmedLine.match(/start="([^"]*)"/);
        const start = startMatch ? startMatch[1] : '';

        // 提取结束时间
        const endMatch = trimmedLine.match(/stop="([^"]*)"/);
        const end = endMatch ? endMatch[1] : '';

        if (currentTvgId && start && end) {
          currentProgram = { start, end, title: '' };
          // 优化：如果当前频道不在我们关注的列表中，标记为跳过
          shouldSkipCurrentProgram = !tvgs.has(currentTvgId);
        }
      }
      // 解析 <title> 标签 - 只有在需要解析当前节目时才处理
      else if (
        trimmedLine.startsWith('<title') &&
        currentProgram &&
        !shouldSkipCurrentProgram
      ) {
        // 处理带有语言属性的title标签，如 <title lang="zh">远方的家2025-60</title>
        const titleMatch = trimmedLine.match(
          /<title(?:\s+[^>]*)?>(.*?)<\/title>/
        );
        if (titleMatch && currentProgram) {
          currentProgram.title = titleMatch[1];

          // 保存节目信息（这里不需要再检查tvgs.has，因为shouldSkipCurrentProgram已经确保了相关性）
          if (!result[currentTvgId]) {
            result[currentTvgId] = [];
          }
          result[currentTvgId].push({ ...currentProgram });

          currentProgram = null;
        }
      }
      // 处理 </programme> 标签
      else if (trimmedLine === '</programme>') {
        currentProgram = null;
        currentTvgId = '';
        shouldSkipCurrentProgram = false; // 重置跳过标志
      }
    }
  } catch (error) {
    // ignore
  }

  return result;
}

/**
 * 解析M3U文件内容，提取频道信息
 * @param m3uContent M3U文件的内容字符串
 * @returns 频道信息数组
 */
function parseM3U(
  sourceKey: string,
  m3uContent: string
): {
  tvgUrl: string;
  channels: {
    id: string;
    tvgId: string;
    name: string;
    logo: string;
    group: string;
    url: string;
    ua?: string;
    referer?: string;
  }[];
} {
  const channels: {
    id: string;
    tvgId: string;
    name: string;
    logo: string;
    group: string;
    url: string;
    ua?: string;
    referer?: string;
  }[] = [];

  const lines = m3uContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let tvgUrl = '';
  let channelIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检查是否是 #EXTM3U 行，提取 tvg-url
    if (line.startsWith('#EXTM3U')) {
      // 支持两种格式：x-tvg-url 和 url-tvg
      const tvgUrlMatch = line.match(/(?:x-tvg-url|url-tvg)="([^"]*)"/);
      tvgUrl = tvgUrlMatch ? tvgUrlMatch[1].split(',')[0].trim() : '';
      continue;
    }

    // #EXTVLCOPT 扩展行（位于 URL 行之后）：流级 UA/Referer 要求，关联到最近添加的频道
    if (line.startsWith('#EXTVLCOPT:')) {
      const last = channels[channels.length - 1];
      if (last) {
        const uaMatch = line.match(/^#EXTVLCOPT:http-user-agent=(.*)$/i);
        if (uaMatch) last.ua = uaMatch[1].trim() || undefined;
        const refMatch = line.match(/^#EXTVLCOPT:http-referrer=(.*)$/i);
        if (refMatch) last.referer = refMatch[1].trim() || undefined;
      }
      continue;
    }

    // 检查是否是 #EXTINF 行
    if (line.startsWith('#EXTINF:')) {
      // 提取 tvg-id
      const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
      const tvgId = tvgIdMatch ? tvgIdMatch[1] : '';

      // 提取 tvg-name
      const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);
      const tvgName = tvgNameMatch ? tvgNameMatch[1] : '';

      // 提取 tvg-logo
      const tvgLogoMatch = line.match(/tvg-logo="([^"]*)"/);
      const logo = tvgLogoMatch ? tvgLogoMatch[1] : '';

      // 提取 group-title
      const groupTitleMatch = line.match(/group-title="([^"]*)"/);
      const group = groupTitleMatch ? groupTitleMatch[1] : '无分组';

      // 提取标题（#EXTINF 行最后的逗号后面的内容）
      const titleMatch = line.match(/,([^,]*)$/);
      const title = titleMatch ? titleMatch[1].trim() : '';

      // 优先使用 tvg-name，如果没有则使用标题
      const name = title || tvgName || '';

      // 检查下一行是否是URL
      if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
        const url = lines[i + 1];

        // 只有当有名称和URL时才添加到结果中
        if (name && url) {
          channels.push({
            id: `${sourceKey}-${channelIndex}`,
            tvgId,
            name,
            logo,
            group,
            url,
          });
          channelIndex++;
        }

        // 跳过下一行，因为已经处理了
        i++;
      }
    }
  }

  return { tvgUrl, channels };
}

// utils/urlResolver.js
export function resolveUrl(baseUrl: string, relativePath: string) {
  try {
    // 如果已经是完整的 URL，直接返回
    if (
      relativePath.startsWith('http://') ||
      relativePath.startsWith('https://')
    ) {
      return relativePath;
    }

    // 如果是协议相对路径 (//example.com/path)
    if (relativePath.startsWith('//')) {
      const baseUrlObj = new URL(baseUrl);
      return `${baseUrlObj.protocol}${relativePath}`;
    }

    // 使用 URL 构造函数处理相对路径
    const baseUrlObj = new URL(baseUrl);
    const resolvedUrl = new URL(relativePath, baseUrlObj);
    return resolvedUrl.href;
  } catch (error) {
    // 降级处理
    return fallbackUrlResolve(baseUrl, relativePath);
  }
}

function fallbackUrlResolve(baseUrl: string, relativePath: string) {
  // 移除 baseUrl 末尾的文件名，保留目录路径
  let base = baseUrl;
  if (!base.endsWith('/')) {
    base = base.substring(0, base.lastIndexOf('/') + 1);
  }

  // 处理不同类型的相对路径
  if (relativePath.startsWith('/')) {
    // 绝对路径 (/path/to/file)
    const urlObj = new URL(base);
    return `${urlObj.protocol}//${urlObj.host}${relativePath}`;
  } else if (relativePath.startsWith('../')) {
    // 上级目录相对路径 (../path/to/file)
    const segments = base.split('/').filter((s) => s);
    const relativeSegments = relativePath.split('/').filter((s) => s);

    for (const segment of relativeSegments) {
      if (segment === '..') {
        segments.pop();
      } else if (segment !== '.') {
        segments.push(segment);
      }
    }

    const urlObj = new URL(base);
    return `${urlObj.protocol}//${urlObj.host}/${segments.join('/')}`;
  } else {
    // 当前目录相对路径 (file.ts 或 ./file.ts)
    const cleanRelative = relativePath.startsWith('./')
      ? relativePath.slice(2)
      : relativePath;
    return base + cleanRelative;
  }
}

// 获取 M3U8 的基础 URL
export function getBaseUrl(m3u8Url: string) {
  try {
    const url = new URL(m3u8Url);
    // 如果 URL 以 .m3u8 结尾，移除文件名
    if (url.pathname.endsWith('.m3u8')) {
      url.pathname = url.pathname.substring(
        0,
        url.pathname.lastIndexOf('/') + 1
      );
    } else if (!url.pathname.endsWith('/')) {
      url.pathname += '/';
    }
    return url.protocol + '//' + url.host + url.pathname;
  } catch (error) {
    return m3u8Url.endsWith('/') ? m3u8Url : m3u8Url + '/';
  }
}
