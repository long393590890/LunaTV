"""新主力猫源固定指纹单次受限补测，不下载媒体。"""
import sys
sys.dont_write_bytecode = True
import hashlib
import importlib.util
import json
from pathlib import Path
from datetime import datetime, timezone

SHA = '00b82deb95b35b4251c08e810b432cb4956ccaf77b703d5b21379388cfc7784b'
URL = 'https://9280.kstore.vip/cat/index.js'
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('batch', Path(__file__).with_name('verify-cat-sources.py'))
batch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(batch)


def main():
    report = {'package': 'niuer_primary', 'created_at': datetime.now(timezone.utc).isoformat(),
              'status': 'download_failed', 'tested_this_run': False,
              'scope': '仅新主力包；一次受限真实调用；不下载媒体，不放宽网络、目录或凭据权限'}
    reviewed_source = None
    if len(sys.argv) > 1:
        if len(sys.argv) != 3 or sys.argv[1] != '--reviewed-source':
            raise SystemExit('参数仅支持 --reviewed-source 临时静态审核包路径')
        reviewed_source = Path(sys.argv[2]).resolve()
        if reviewed_source.name != 'source.cjs' or not reviewed_source.parent.name.startswith('lunatv-primary-review-'):
            raise SystemExit('仅接受本次静态审核临时包')
    try:
        data = reviewed_source.read_bytes() if reviewed_source else batch.SINGLE.download(URL, 15_000_000)
        actual = hashlib.sha256(data).hexdigest()
        report['download'] = {'bytes': len(data), 'sha256': actual, 'expected_sha256': SHA, 'sha256_match': actual == SHA,
                              'reused_this_session_download': reviewed_source is not None,
                              'md5_note': '前代理已校验MD5；本次仅固定SHA256，不重复下载校验文件'}
        if actual != SHA:
            report['status'] = 'fingerprint_changed'
            return
        text = data.decode('utf-8')
        tokens = ['Yi(tkr,{start:()=>oK0,stop:()=>sK0});module.exports=Knt(tkr)',
                  'async function oK0(', 'async function nK0(', 'bj=class', 'async function KAr(',
                  'function wd0()', 'http://v.rbotv.cn', 'async function Hq(', 'async function WGt(',
                  'async function ah0(', 'prepare(){', 'async function zZ0(', 'async function YZ0(']
        report['static_review'] = {
            'evidence': [{'token': token, 'offset': text.find(token), 'line': text.count('\n', 0, text.find(token)) + 1 if token in text else None} for token in tokens],
            'exports': '真实CommonJS映射start=oK0、stop=sK0；尾部0&&导出仅为构建标记',
            'startup': 'start使用catServerFactory和catDartServerPort；配置存储默认cwd，无NODE_PATH；queryProfile经宿主回调，端口0返回null。远程配置初始化包含混淆辅助代码，不授权其网络；后台转存任务均先检查临时配置凭据，空配置不可进入账户操作。未发现此受限空凭据调用链要求额外危险权限；不据此认定整个包安全。',
            'rebo': 'init返回空对象；search/detail通过Hq访问固定HTTP域；play可能请求详情提供的解析地址，未知域一律拒绝；返回媒体地址仅在内存检查，不抓取或输出',
            'hosts': {'v.rbotv.cn': 'http:'}, 'additional_network_approved': False,
            'decision': '仅批准此固定指纹在既有最小宿主和原权限策略内尝试一次；缺回调或权限即记录失败'}
        if any(token not in text for token in tokens):
            report['status'] = 'static_blocked'
            report['failure_reason'] = '已审核结构标记缺失'
            return
        report['tested_this_run'] = True
        batch.runtime(report, data, (SHA, ['rebo'], {'v.rbotv.cn': 'http:'}))
    except Exception as error:
        report['status'] = 'runtime_failed' if report['tested_this_run'] else 'download_failed'
        report['failure_type'] = type(error).__name__
    finally:
        # 仅保留事件类别、状态及代码，去掉上游路径和错误栈等潜在敏感值。
        runtime = report.get('runtime', {})
        if 'network_evidence' in runtime:
            runtime['network_evidence'] = [{key: value for key, value in event.items()
                                          if key in ('event', 'host', 'protocol', 'status', 'code', 'permission')}
                                         for event in runtime['network_evidence']]
        report['source_download_cleanup'] = {'remote_js_retained': False}
        if reviewed_source:
            reviewed_source.unlink(missing_ok=True)
            reviewed_source.parent.rmdir()
            report['source_download_cleanup']['temporary_directory_removed'] = not reviewed_source.parent.exists()
        output = ROOT / 'outputs' / 'primary-cat-verification.json'
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({key: report.get(key) for key in ('status', 'tested_this_run', 'failure_reason', 'cleanup', 'source_download_cleanup')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
