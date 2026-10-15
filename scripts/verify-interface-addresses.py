"""逐地址核验公开配置及猫源校验，报告不保存远程配置或代码。
复跑认证入口前，通过LUNATV_INTERFACE_BASIC环境变量提供用户名:密码；不在代码或报告保存凭据。
"""
import base64
import concurrent.futures
from collections import Counter
from datetime import datetime, timezone
import hashlib
import os
import json
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'outputs'
LIMIT = 15_000_000
OLD_SHA = 'ee12e235e95eb1135f758f06c644ee423b2a7a83049b716db2db6b95670243dc'
URLS = [
    'https://9280.kstore.vip/aiwex.json', 'https://9280.kstore.space/aiwex.json',
    'http://ai.xn--4kq62z5rby2qupq9ub.top/', 'http://new.王二小放牛娃.top/',
    'http://new.999888123.xyz/', 'http://new.999888987.xyz/',
    'https://9280.kstore.vip/newwex.json', 'http://tvbox.王二小放牛娃.top/',
    'http://tvbox.xn--4kq62z5rby2qupq9ub.top/', 'http://tv.999888987.xyz/',
    'http://tv.999888123.xyz/', 'https://9280.kstore.vip/wex.json',
    'http://cat.xn--4kq62z5rby2qupq9ub.top/index.js.md5',
    'http://cat.999888987.xyz/index.js.md5', 'http://cat.999888123.xyz/index.js.md5',
    'https://9280.kstore.vip/cat/index.js.md5',
]
AUTH = base64.b64encode(os.environ.get('LUNATV_INTERFACE_BASIC', '').encode()).decode()


def normalize(url):
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or '').encode('idna').decode()
    if u.port:
        host += ':' + str(u.port)
    return urllib.parse.urlunsplit((u.scheme, host, u.path or '/', u.query, ''))


def safe_url(url):
    u = urllib.parse.urlsplit(normalize(url))
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, '[已脱敏]' if u.query else '', ''))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url, authenticated=False):
    started = time.monotonic()
    current = normalize(url)
    origin = urllib.parse.urlsplit(current).netloc
    evidence = {'url': safe_url(current), 'redirects': [], 'status': 'failed', 'failure_stage': 'request'}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    data = b''
    try:
        if authenticated and not os.environ.get('LUNATV_INTERFACE_BASIC') and not AUTH:
            raise ValueError('missing_auth_environment')
        for _ in range(7):
            headers = {'User-Agent': 'LunaTV-interface-verifier/1.0', 'Accept-Encoding': 'identity'}
            if authenticated and urllib.parse.urlsplit(current).netloc == origin:
                headers['Authorization'] = 'Basic ' + AUTH
            request = urllib.request.Request(current, headers=headers)
            try:
                response = opener.open(request, timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                evidence.update(http_status=response.status, content_type=response.headers.get('Content-Type', ''), final_url=safe_url(current))
                if response.status in (301, 302, 303, 307, 308):
                    target = normalize(urllib.parse.urljoin(current, response.headers.get('Location', '')))
                    if urllib.parse.urlsplit(target).scheme not in ('http', 'https'):
                        raise ValueError('redirect_scheme')
                    evidence['redirects'].append({'http_status': response.status, 'url': safe_url(target), 'authorization_forwarded': authenticated and urllib.parse.urlsplit(target).netloc == origin})
                    if urllib.parse.urlsplit(target).netloc != origin:
                        authenticated = False
                    current = target
                    continue
                evidence['failure_stage'] = 'body'
                chunks = []
                size = 0
                while True:
                    if time.monotonic() - started > 20:
                        raise TimeoutError('total_deadline')
                    block = response.read(min(65536, LIMIT + 1 - size))
                    if not block:
                        break
                    chunks.append(block)
                    size += len(block)
                    if size > LIMIT:
                        raise ValueError('size_limit')
                data = b''.join(chunks)
                evidence.update(bytes=len(data), md5=hashlib.md5(data).hexdigest(), sha256=hashlib.sha256(data).hexdigest(), status='ok' if 200 <= response.status < 300 else 'http_error', failure_stage=None if 200 <= response.status < 300 else 'http')
                break
        else:
            raise ValueError('redirect_limit')
    except Exception as error:
        evidence['error_type'] = type(error).__name__
        reason = getattr(error, 'reason', None)
        if reason is not None:
            evidence['network_error_type'] = type(reason).__name__
        if isinstance(error, ValueError):
            evidence['reason'] = str(error) if str(error) in ('size_limit', 'redirect_limit', 'redirect_scheme', 'missing_auth_environment') else 'invalid_url'
    evidence['elapsed_ms'] = round((time.monotonic() - started) * 1000)
    return evidence, data


def classify(data):
    text = data.decode('utf-8-sig', errors='replace').strip()
    try:
        obj = json.loads(text)
        return ('tvbox_json' if isinstance(obj, dict) and any(k in obj for k in ('sites', 'spider', 'parses')) else 'json'), obj
    except Exception:
        if re.fullmatch(r'[a-fA-F0-9]{32}', text):
            return 'md5', None
        if re.search(r'<(?:!doctype|html|head|body)\b', text[:2000], re.I):
            return 'html', None
        if any(x in text for x in ('module.exports', 'function(', 'function ', 'var ', 'const ', 'let ')):
            return 'javascript', None
        if text.startswith(('2423', '**')) or re.fullmatch(r'[A-Za-z0-9+/=\s]{100,}', text):
            return 'possibly_encrypted_or_encoded', None
        return 'unparsed_text_or_binary', None


def value_type(value):
    if isinstance(value, str):
        if value.startswith(('http://', 'https://')):
            return 'http_url'
        if value.startswith('csp_'):
            return 'csp'
        if '.js' in value.lower():
            return 'javascript_reference'
        if value:
            return 'other_string'
        return 'empty_string'
    return type(value).__name__


def structure(obj):
    sites = obj.get('sites', [])
    sites = sites if isinstance(sites, list) else []
    sites = [s for s in sites if isinstance(s, dict)]
    spider = obj.get('spider')
    return {'sites_count': len(sites), 'parses_count': len(obj.get('parses', [])) if isinstance(obj.get('parses'), list) else 0,
            'spider_count': int(bool(spider)), 'spider_type': value_type(spider),
            'site_type_distribution': dict(Counter(str(s.get('type', 'missing')) for s in sites)),
            'api_type_distribution': dict(Counter(value_type(s.get('api')) for s in sites)),
            'ext_type_distribution': dict(Counter(value_type(s.get('ext')) for s in sites)),
            'runtime_dependencies': 'JAR/CSP、JavaScript、DRPY需相应宿主，未执行；配置可读不代表影视源可用'}


def ordinary_candidates(objects):
    found = []
    seen = set()
    for origin, obj in objects:
        if not isinstance(obj, dict):
            continue
        for site in obj.get('sites', []) if isinstance(obj.get('sites'), list) else []:
            if not isinstance(site, dict):
                continue
            name = str(site.get('name', ''))
            api = site.get('api')
            if not re.search(r'非凡|量子|最大|红牛|光速|新浪|魔都|如意|卧龙|索尼|快车|暴风|ikun', name, re.I):
                continue
            if re.search(r'成人|情色|福利|伦理|成人视频|无码|有码|AV|番号|精品|写真', name, re.I):
                continue
            if not isinstance(api, str) or not api.startswith(('http://', 'https://')) or not re.search(r'/api\.php|/provide/vod|/api/vod', api, re.I):
                continue
            if re.search(r'\.js(?:[?;]|$)|csp_|drpy|\.jar', api, re.I):
                continue
            try:
                api = normalize(api)
            except Exception:
                continue
            if api in seen:
                continue
            seen.add(api)
            found.append((origin, api))
            if len(found) == 3:
                return found
    return found


def query_url(api, params):
    u = urllib.parse.urlsplit(api)
    query = dict(urllib.parse.parse_qsl(u.query))
    query.update(params)
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, urllib.parse.urlencode(query), ''))


def sample(candidate):
    origin, api = candidate
    report = {'config_sha256': origin, 'api': safe_url(api), 'keyword': '熊出没', 'search': None, 'detail': None, 'status': 'search_failed'}
    ev, data = fetch(query_url(api, {'ac': 'videolist', 'wd': '熊出没'}))
    report['search'] = ev
    _, obj = classify(data)
    items = obj.get('list', []) if isinstance(obj, dict) else []
    ev['result_count'] = len(items) if isinstance(items, list) else 0
    chosen = next((i for i in items if isinstance(i, dict) and re.fullmatch(r'熊出没[\u4e00-\u9fff0-9·：:之\s-]*', str(i.get('vod_name', '')))), None) if isinstance(items, list) else None
    if ev['status'] != 'ok' or not chosen:
        report['reason'] = '没有有效的明确儿童动画匹配；未请求其他内容'
        return report
    ev, data = fetch(query_url(api, {'ac': 'videolist', 'ids': str(chosen.get('vod_id', ''))}))
    report['detail'] = ev
    _, obj = classify(data)
    items = obj.get('list', []) if isinstance(obj, dict) else []
    ev['result_count'] = len(items) if isinstance(items, list) else 0
    ev['has_play_fields'] = any(bool(i.get('vod_play_url')) for i in items if isinstance(i, dict)) if isinstance(items, list) else False
    report['status'] = 'search_detail_ok' if ev['status'] == 'ok' and ev['has_play_fields'] else 'detail_failed'
    report['play_note'] = '仅确认详情提供播放字段，未验证解析或媒体播放'
    return report


def main():
    history = json.loads((OUT / 'cat-sources-verification.json').read_text(encoding='utf-8'))
    historical = {p.get('download', {}).get('sha256'): p for p in history.get('packages', [])}
    report = {'schema_version': 1, 'created_at': datetime.now(timezone.utc).isoformat(), 'scope': '16个原始入口逐个请求；同内容只分析一次；最多3个普通影视采集候选；不保存远程配置/代码，不下载媒体',
              'limits': {'http_socket_timeout_seconds': 15, 'request_total_deadline_seconds': 20, 'response_bytes': LIMIT, 'retries': 0, 'notes': 'socket读取超时与总时限结合；每次读取后检查总时限，无无限重试'}, 'addresses': [], 'config_groups': [], 'cat_packages': [], 'api_samples': []}
    objects = []
    package_jobs = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda url: fetch(url, '/index.js.md5' in url and 'kstore' not in url), URLS))
        for url, (ev, data) in zip(URLS, results):
            kind, obj = classify(data)
            ev['input_url'] = url
            ev['classification'] = kind
            ev['json_parse_ok'] = kind in ('json', 'tvbox_json')
            if data.decode('utf-8', errors='replace').strip() == '你好！':
                ev['short_response_text'] = '你好！'
            elif len(data) <= 32 and re.fullmatch(rb'[A-Za-z0-9 _!.-]+', data):
                ev['short_response_text'] = data.decode('ascii')
            ev['authenticated_request'] = '/index.js.md5' in url and 'kstore' not in url
            report['addresses'].append(ev)
            if ev['status'] != 'ok':
                ev['conclusion'] = '入口请求失败，不能判断源是否可用'
            elif kind == 'tvbox_json':
                ev['structure'] = structure(obj)
                ev['conclusion'] = '配置可读取；JAR/JS源需宿主，采集源仅以抽查结果为准'
                objects.append((ev['sha256'], obj))
            elif kind == 'md5':
                ev['conclusion'] = 'MD5文本可读取，待对应JS校验'
            else:
                ev['conclusion'] = '未识别为可直接接入的TVBox JSON配置'
            if url.endswith('.md5'):
                package_jobs.append((url[:-4], data.decode(errors='replace').strip() if kind == 'md5' else None, ev))
        jobs = list(pool.map(lambda job: fetch(job[0], 'kstore' not in job[0]), package_jobs))
    for (url, expected, parent), (ev, data) in zip(package_jobs, jobs):
        item = {'download': ev, 'checksum_entry_url': parent['url'], 'remote_md5': expected, 'md5_match': ev.get('md5') == expected.lower() if expected else None,
                'matches_prior_niuer': ev.get('sha256') == OLD_SHA}
        text = data.decode('utf-8', errors='replace')
        item['static_review'] = {'commonjs_export': 'module.exports' in text, 'host_callbacks': [n for n in ('catServerFactory', 'catDartServerPort') if n in text],
                                 'rebo_marker': 'key:"rebo"' in text, 'reviewed_upstream_marker': 'v.rbotv.cn' in text,
                                 'dangerous_token_counts': {n: text.count(n) for n in ('child_process', 'execSync', 'spawn(', 'eval(', 'new Function', 'worker_threads', 'createRequire')}}
        previous = historical.get(ev.get('sha256'))
        if previous and item['md5_match']:
            item['runtime'] = {'executed_now': False, 'historical_reference': 'outputs/cat-sources-verification.json', 'historical_package': previous.get('package'), 'historical_status': previous.get('status'), 'historical_tested_at': previous.get('tested_at', history.get('created_at')), 'note': '相同SHA256复用历史包级证据，不代表入口本次上游可用'}
            item['conclusion'] = '校验通过且与历史已测包完全相同；运行证据引用历史'
        else:
            item['runtime'] = {'executed_now': False, 'reason': '新指纹无法在本轮内充分完成导出/启动/网络行为静态审核；禁止仅凭候选标记执行'}
            item['conclusion'] = 'JS下载/校验结果见字段；新指纹未执行，不能确认搜索详情play'
        parent['cat_package_sha256'] = ev.get('sha256')
        parent['conclusion'] = item['conclusion']
        report['cat_packages'].append(item)
    package_groups = {}
    for item in report['cat_packages']:
        sha = item['download'].get('sha256')
        if sha:
            package_groups.setdefault(sha, []).append(item['download']['url'])
    report['cat_package_groups'] = [{'sha256': sha, 'urls': urls} for sha, urls in package_groups.items()]
    report['protocol_notes'] = 'HTTP配置域名和HTTPS存储直链分别核验，不将不同路径/主机差异归因于HTTP协议；猫JS跨域重定向已剥离Basic认证。Content-Type可能不准确，按内容及指纹识别。'
    groups = {}
    for ev in report['addresses']:
        if ev.get('sha256'):
            groups.setdefault(ev['sha256'], []).append(ev['url'])
    report['config_groups'] = [{'sha256': sha, 'urls': urls} for sha, urls in groups.items()]
    candidates = ordinary_candidates(objects)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        report['api_samples'] = list(pool.map(sample, candidates))
    report['candidate_note'] = '只选择名称明确普通且API形似苹果CMS的前3个去重HTTP源；不输出其他站名或链接；候选不足不扩大到可疑内容'
    report['unverified'] = ['所有JAR/CSP/DRPY运行', '未抽查的HTTP采集站', '所有媒体实际播放、可持续性和速度', '所有新指纹猫包的执行与搜索详情play', '加密内容解密、额外配置依赖']
    report['finished_at'] = datetime.now(timezone.utc).isoformat()
    OUT.mkdir(exist_ok=True)
    (OUT / 'interface-addresses-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    lines = ['接口地址验证报告', '生成时间：' + report['created_at'], report['scope'], '']
    for i, ev in enumerate(report['addresses'], 1):
        lines += [f"{i}. {ev['url']}", f"   HTTP={ev.get('http_status', '无')} 类型={ev['classification']} 字节={ev.get('bytes', 0)} 耗时={ev['elapsed_ms']}ms 阶段={ev.get('failure_stage')}", '   ' + ev['conclusion'], '   SHA256=' + str(ev.get('sha256', '无'))]
        if 'structure' in ev:
            lines.append('   结构=' + json.dumps(ev['structure'], ensure_ascii=False))
    lines += ['', '猫包校验：']
    for item in report['cat_packages']:
        lines += [item['download']['url'], f"MD5匹配={item['md5_match']} 历史niuer同包={item['matches_prior_niuer']} SHA256={item['download'].get('sha256')}", item['conclusion']]
    lines += ['', '普通采集抽查：']
    for item in report['api_samples']:
        lines.append(item['api'] + ' ' + item['status'])
    lines += ['', '同指纹组：']
    for group in report['config_groups']:
        lines.append(group['sha256'] + ' ' + ' | '.join(group['urls']))
    lines += ['', '未验证：' + '；'.join(report['unverified'])]
    (OUT / 'interface-addresses-verification.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'addresses': len(report['addresses']), 'readable': sum(e['status'] == 'ok' for e in report['addresses']), 'api_samples': len(report['api_samples']), 'cat_packages': len(report['cat_packages'])}))


def test_new_cat():
    import importlib.util
    spec = importlib.util.spec_from_file_location('batch', ROOT / 'scripts/verify-cat-sources.py')
    batch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(batch)
    ev, data = fetch('https://9280.kstore.vip/cat/index.js')
    expected = '00b82deb95b35b4251c08e810b432cb4956ccaf77b703d5b21379388cfc7784b'
    if ev.get('sha256') != expected:
        raise ValueError('已审核新包指纹变化，拒绝执行')
    runtime = {'package': 'interface_main', 'tested_at': datetime.now(timezone.utc).isoformat(), 'fixed_sha256': expected,
               'review': {'exports': 'start=oK0,stop=sK0', 'server_constructor': 'nK0使用注入serverFactory；本机消息回调端口固定0',
                          'candidate': 'wd0:rebo', 'search_path': '/v3/home/search', 'detail_path': '/v3/home/vod_details',
                          'upstream': 'http://v.rbotv.cn', 'play': 'WGt可能解析动态域名，只允许固定审核上游，其他域拒绝',
                          'startup': '配置加载/remoteWexConfig/全体注册在原宿主权限下运行；未授权外联和外部文件访问仍拒绝'}}
    batch.runtime(runtime, data, (expected, ['rebo'], {'v.rbotv.cn': 'http:'}))
    path = OUT / 'interface-addresses-verification.json'
    report = json.loads(path.read_text(encoding='utf-8'))
    report['new_cat_runtime'] = runtime
    for item in report['cat_packages']:
        if item['download'].get('sha256') == expected:
            item['runtime'] = {'executed_now': True, 'same_fingerprint_single_run_reference': 'new_cat_runtime', 'status': runtime.get('status')}
            item['conclusion'] = 'MD5校验通过；同指纹包受限rebo验证结果见new_cat_runtime'
    for item in report['addresses']:
        if item.get('cat_package_sha256') == expected:
            item['conclusion'] = 'MD5校验通过；同指纹包受限rebo验证结果见new_cat_runtime'
    report['unique_normalized_input_url_count'] = len(set(normalize(url) for url in URLS))
    report['lunatv_import_note'] = 'TVBox sites/spider配置可被语法接受，但无api_site时不会自动导入源；本轮不调用线上导入，不修改正式配置'
    report['unverified'] = [s for s in report['unverified'] if s != '所有新指纹猫包的执行与搜索详情play']
    report['unverified'].append('新猫包仅以new_cat_runtime阶段结果为准，未完成的搜索详情play仍未验证')
    report['supplemented_at'] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    path = OUT / 'interface-addresses-verification.txt'
    previous_text = path.read_text(encoding='utf-8').split('\n新猫包受限运行补测')[0]
    previous_text = previous_text.replace('JS下载/校验结果见字段；新指纹未执行，不能确认搜索详情play', 'JS下载/校验通过；rebo受限验证play已解析，见末尾补测')
    path.write_text(previous_text + '\n新猫包受限运行补测：\n' + json.dumps(runtime, ensure_ascii=False, indent=2) + '\n16原始入口=15唯一IDNA URL；tvbox中文域与punycode同主机。\n配置可读不等于LunaTV自动导入：缺api_site不会生成源。\n', encoding='utf-8')
    print(json.dumps(runtime, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    if '--test-new-cat' in sys.argv:
        test_new_cat()
    else:
        main()
