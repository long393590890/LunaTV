"""独立猫源验证：固定审核指纹，临时目录运行，不修改应用代码。"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'outputs'
NODE = Path('C:/Users/86153/.workbuddy/binaries/node/versions/22.22.2-6/node.exe')
URL = 'https://ghfast.top/https://raw.githubusercontent.com/nitan-tv/nitan/refs/heads/main/js/index.js'
AUDITED_SHA256 = 'fc57bf68c45db5a23838ed3a599c2d3956182bae388cd42c3aac90bc83131fe7'

# 此适配器只补齐已静态确认的宿主能力；远程源码保持原样。
HOST = r'''
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(options, ...args) {
  if (!options || typeof options !== 'object') throw Error('禁止未知监听方式');
  return listen.call(this, {...options, host:'127.0.0.1', port:0}, ...args);
};
for (const [mod, protocol] of [[http,'http:'], [https,'https:']]) {
  const request = mod.request;
  mod.request = function(options, ...args) {
    if (!options || typeof options !== 'object') throw Error('禁止未知出站方式');
    const host = options.hostname || options.host;
    if (host !== 'vod.catvod.ggff.net' || protocol !== 'https:' || options.socketPath)
      throw Error('出站目标未获准');
    if (!/^\/(guazi|uvod)(\?|$)/.test(options.path || '')) throw Error('出站路径未获准');
    const req = request.call(this, {...options, rejectUnauthorized:true}, ...args);
    req.setTimeout(15000, () => req.destroy(Error('上游请求超时')));
    return req;
  };
}
globalThis.catDartServerPort = () => 0;
globalThis.catServerFactory = (handler) => {
  const server = http.createServer((req,res) => {
    if (!/^(?:\/check|\/spider\/(?:guazi|uvod)\/3\/(?:init|home|category|search|detail|play))$/.test(req.url.split('?')[0])) {
      res.writeHead(403); res.end(); return;
    }
    handler(req,res);
  });
  server.once('listening', () => fs.writeFileSync('ready.json', JSON.stringify(server.address())));
  return server;
};
const source = require(path.join(process.cwd(), 'source.cjs'));
if (typeof source.start !== 'function' || typeof source.stop !== 'function') throw Error('真实导出不匹配');
source.start({color:[]}).catch(() => process.exit(2));
setTimeout(() => { source.stop(); process.exit(0); }, 140000);
'''


def download(url, limit):
    started = time.monotonic()
    # 不继承机器代理设置；下载器只处理指定的公开源码地址。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=35) as response:
        data = bytearray()
        while True:
            if time.monotonic() - started > 60:
                raise TimeoutError('下载超过总时限 60 秒')
            block = response.read(min(65536, limit + 1 - len(data)))
            if not block:
                break
            data.extend(block)
            if len(data) > limit:
                raise ValueError('下载超过大小限制')
        return bytes(data)


def location(text, needle):
    offset = text.find(needle)
    return {'line': text.count('\n', 0, offset) + 1, 'offset': offset,
            'excerpt': text[max(0, offset - 50):offset + len(needle) + 180]}


def run(report):
    data = download(URL, 3_000_000)
    checksum = download(URL + '.md5', 4096).decode().strip()
    md5 = hashlib.md5(data).hexdigest()
    sha256 = hashlib.sha256(data).hexdigest()
    report['download'] = {'url': URL, 'bytes': len(data), 'md5': md5,
                          'remote_md5': checksum, 'sha256': sha256,
                          'md5_match': bool(re.fullmatch(r'[0-9a-fA-F]{32}', checksum)) and md5 == checksum.lower()}
    if not report['download']['md5_match']:
        raise ValueError('远程 MD5 不匹配')
    if sha256 != AUDITED_SHA256:
        raise ValueError('源码已改变：必须重新静态审核，禁止执行')
    text = data.decode('utf-8')
    needles = ['globalThis.websiteBundle', '$A(Iqe,{start:()=>kqe,stop:()=>Nqe})',
               'serverFactory:catServerFactory', 'catDartServerPort()', 'host:"0.0.0.0"',
               's.check?.(e)', 'rejectUnauthorized:!1', 'var BH={meta:', 'async function ANe',
               'async function PNe', 'async function TNe']
    report['static_review'] = {
        'fingerprint_reviewed': True,
        'evidence': [location(text, n) for n in needles],
        'requires': sorted(set(re.findall(r'require\("([^"\n]+)"\)', text))),
        'dangerous_tokens': {n: text.count(n) for n in ['child_process', 'execSync', 'spawn(', 'eval(', 'new Function', 'worker_threads', 'createRequire']},
        'conclusion': '存在真实 CommonJS 导出及猫影视宿主回调；不能直接裸启动。动态代码生成属于内置路由/校验库。未发现启动自动安装或更新；仅通过受限宿主运行。',
        'routes': ['/spider/{key}/{type}/' + n for n in ['init', 'home', 'category', 'detail', 'play', 'search']],
        'source_selection': ['guazi', 'uvod'],
    }
    report['isolation'] = {
        'environment': '仅 SystemRoot、临时 TEMP/TMP、NODE_ENV=development；不继承凭据/代理/NODE_OPTIONS',
        'filesystem': 'Node --permission；仅临时 cwd 可读写；不授予项目或用户目录',
        'denied': ['子进程', 'Worker', '原生插件', 'WASI'],
        'listen': '宿主强制 127.0.0.1 随机端口，启动后核对实际地址',
        'outbound': 'HTTP(S) 封装仅准许 https://vod.catvod.ggff.net/{guazi,uvod}；禁止重定向到其他目标；恢复 TLS 证书校验',
        'limitation': 'Node 权限模型及 JS 网络守卫不是 OS 网络沙箱；仅执行上述固定、已审核指纹，不对任意远程代码提供安全保证。',
        'dependencies': '不安装依赖；若触发未内联外部模块则失败退出',
    }
    report['requests'] = []
    report['status'] = 'runtime_failed'
    with tempfile.TemporaryDirectory(prefix='lunatv-cat-') as tmp:
        directory = Path(tmp)
        (directory / 'source.cjs').write_bytes(data)
        (directory / 'host.cjs').write_text(HOST, encoding='utf-8')
        env = {'SystemRoot': os.environ.get('SystemRoot', 'C:/Windows'), 'TEMP': tmp,
               'TMP': tmp, 'NODE_ENV': 'development'}
        command = [str(NODE), '--permission', '--allow-fs-read=' + tmp,
                   '--allow-fs-write=' + tmp, '--no-addons', '--max-old-space-size=192',
                   str(directory / 'host.cjs')]
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(command, cwd=tmp, env=env, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            report['runtime'] = {'started': True, 'pid': process.pid, 'source_unchanged': True}
            try:
                deadline = time.monotonic() + 20
                while not (directory / 'ready.json').exists():
                    if process.poll() is not None:
                        raise RuntimeError('Node 在监听前退出')
                    if time.monotonic() > deadline:
                        raise TimeoutError('启动超时')
                    time.sleep(0.1)
                address = json.loads((directory / 'ready.json').read_text())
                report['runtime']['address'] = address
                if address.get('address') != '127.0.0.1':
                    raise RuntimeError('实际监听地址不符合要求')
                base = 'http://127.0.0.1:' + str(address['port'])
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

                def call(route, body=None):
                    evidence = {'method': 'GET' if body is None else 'POST', 'path': route,
                                'request': body}
                    report['requests'].append(evidence)
                    start = time.monotonic()
                    req = urllib.request.Request(base + route, data=None if body is None else json.dumps(body).encode(),
                                                 headers={'Content-Type': 'application/json'})
                    try:
                        try:
                            response = opener.open(req, timeout=22)
                        except urllib.error.HTTPError as error:
                            response = error
                        with response:
                            raw = response.read(2_000_001)
                            evidence['http_status'] = response.status
                            evidence['bytes'] = len(raw)
                            if len(raw) > 2_000_000:
                                raise ValueError('响应超过大小限制')
                            obj = json.loads(raw)
                            # 不保存播放地址、上游响应头和自由文本，避免泄露签名或凭据。
                            evidence['response'] = {'kind': type(obj).__name__, 'keys': list(obj) if isinstance(obj, dict) else [],
                                                    'list_count': len(obj.get('list', [])) if isinstance(obj, dict) else None}
                            if response.status >= 400:
                                evidence['error'] = {'code': obj.get('code'), 'message': '上游或源处理器返回错误（原始消息已省略）'}
                                return None
                            return obj
                    except Exception as error:
                        evidence['error'] = {'type': type(error).__name__, 'message': '本机接口请求或 JSON 解析失败'}
                        return None
                    finally:
                        evidence['elapsed_ms'] = round((time.monotonic() - start) * 1000)

                report['runtime']['health_probe'] = '使用 /spider/guazi/3/init；源码 /check 在本宿主实测触发 ERR_HTTP_HEADERS_SENT 并退出，故不用于就绪检查。'
                report['runtime']['health_route_issue'] = {'path': '/check', 'http_status': 200, 'bytes': 0, 'error_code': 'ERR_HTTP_HEADERS_SENT', 'observed_in_previous_run': True}
                report['status'] = 'upstream_failed'
                for key in ['guazi', 'uvod']:
                    prefix = '/spider/' + key + '/3/'
                    call(prefix + 'init', {})
                    result = call(prefix + 'search', {'wd': '熊出没', 'page': 1})
                    if not result or not result.get('list'):
                        continue
                    # 仅选择明确匹配儿童动画标题的记录，不遍历其他内容。
                    item = next((x for x in result['list'] if re.fullmatch(r'熊出没[\u4e00-\u9fff0-9·：:之\s-]*', str(x.get('vod_name', '')))), None)
                    if not item:
                        continue
                    detail = call(prefix + 'detail', {'id': item['vod_id']})
                    if not detail or not detail.get('list'):
                        continue
                    vod = detail['list'][0]
                    if '熊出没' not in str(vod.get('vod_name', '')):
                        continue
                    groups = str(vod.get('vod_play_url', '')).split('$$$')
                    flags = str(vod.get('vod_play_from', '')).split('$$$')
                    first = groups[0].split('#')[0].split('$', 1)
                    if len(first) != 2 or not first[1]:
                        continue
                    play = call(prefix + 'play', {'id': first[1], 'flag': flags[0]})
                    # 请求证据中也删除可能含凭据的播放 ID。
                    report['requests'][-1]['request']['id'] = '[播放 ID 已脱敏]'
                    if play and play.get('url'):
                        report['status'] = 'play_resolved'
                        report['play'] = {'source': key, 'parse': play.get('parse'), 'url_present': True,
                                          'media_fetched': False, 'note': '仅验证解析结果；未下载或播放媒体'}
                        break
                if report['status'] == 'upstream_failed':
                    report['failure_reason'] = '本机宿主已启动，但候选源搜索未完成有效搜索→详情→play 闭环；以 requests 证据为准。'
            finally:
                report['runtime']['termination_requested'] = process.poll() is None
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                report['runtime']['exit_code'] = process.returncode
                report['runtime']['process_stopped'] = process.poll() is not None
                log.seek(0)
                output = log.read(256000).decode('utf-8', errors='replace')
                # 仅保留注册路径和已知错误码，丢弃原始日志。
                report['runtime']['registered_paths'] = sorted(set(re.findall(r'Register spider: (/spider/[a-zA-Z0-9_/-]+)', output)))
                report['runtime']['error_codes'] = sorted(set(re.findall(r'\b(?:ERR_[A-Z_]+|EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+)\b', output)))
    report['cleanup'] = {'temporary_directory_removed': not directory.exists(), 'raw_runtime_log_retained': False}


def main():
    report = {'schema_version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
              'status': 'static_blocked', 'scope': '独立验证；未修改正式 src；未提交或部署'}
    try:
        run(report)
    except Exception as error:
        report['failure_reason'] = str(error)[:250]
        report['failure_type'] = type(error).__name__
    OUT.mkdir(exist_ok=True)
    (OUT / 'cat-source-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    lines = ['猫源独立验证报告', '状态：' + report['status'], '时间：' + report['created_at'], report['scope'],
             'MD5：' + report.get('download', {}).get('md5', '未取得'),
             '失败原因：' + report.get('failure_reason', '无'),
             '约束：仅固定审核指纹；临时 cwd；Node 权限模式；仅本机监听；不继承凭据；不安装、不更新。',
             '说明：play_resolved 只表示解析成功，不代表媒体已播放；本次未验证 LunaTV 前端集成。', '', '完整脱敏证据：',
             json.dumps(report, ensure_ascii=False, indent=2)]
    (OUT / 'cat-source-verification.txt').write_text('\n'.join(lines), encoding='utf-8')
    print(json.dumps({'status': report['status'], 'failure_reason': report.get('failure_reason'),
                      'reports': [str(OUT / ('cat-source-verification.' + ext)) for ext in ['json', 'txt']]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
