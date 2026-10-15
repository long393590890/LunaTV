"""备用猫源逐包校验、静态审核及固定指纹受限运行。"""
import concurrent.futures
import hashlib
import importlib.util
import sys
sys.dont_write_bytecode = True
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'outputs'
SPEC = importlib.util.spec_from_file_location('single_verifier', Path(__file__).with_name('verify-cat-source.py'))
SINGLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SINGLE)
PREFIX = 'https://ghfast.top/https://raw.githubusercontent.com/'
PACKAGES = [(key, 'Darklessing/catvod/refs/heads/main/' + key + '/index.js') for key in ['niuer', 'lmentor', 'douer', 'smdl', 'xuenai']] + [
    ('fangkuia', 'fangkuia/XPTV/refs/heads/main/dist/index.js'),
    ('ggboomla', 'ggboomla/catpaw/refs/heads/x3/index.js'),
    ('androwsc', 'androwsc/catvod/refs/heads/main/ad/index.js')]


def collect(entry, directory):
    key, path = entry
    report = {'package': key, 'url': PREFIX + path, 'status': 'download_failed'}
    try:
        data = SINGLE.download(report['url'], 15_000_000)
        checksum = SINGLE.download(report['url'] + '.md5', 4096).decode().strip()
        report['download'] = {'bytes': len(data), 'md5': hashlib.md5(data).hexdigest(), 'remote_md5': checksum, 'sha256': hashlib.sha256(data).hexdigest()}
        report['download']['md5_match'] = bool(re.fullmatch('[0-9a-fA-F]{32}', checksum)) and report['download']['md5'] == checksum.lower()
        (directory / (key + '.js')).write_bytes(data)
        report['status'] = 'awaiting_static_review' if report['download']['md5_match'] else 'checksum_failed'
    except Exception as error:
        report['failure_reason'] = str(error)[:200]
    return report


AUDITED = {
    'niuer': ('ee12e235e95eb1135f758f06c644ee423b2a7a83049b716db2db6b95670243dc', ['rebo', 'libvio'], {'v.rbotv.cn': 'http:', 'www.libvio.pw': 'https:'}),
    'lmentor': ('842d0097f99c574f352e2c1e67818e9f4ae4f558597b8ee5057fbda12a46afcb', ['jinpai'], {'www.jiabaide.cn': 'https:'}),
    'douer': ('0ad3ed101dc961e6d73b758a5089ac1e10a12d27666468436e1fff2e39df01cc', ['jinpai'], {'m.jiabaide.cn': 'https:'}),
    'smdl': ('2a8de45906bb5f86edcb943c079773a2f839fea2cb21cc7371f90ef336a987ca', ['jinpai'], {host: 'https:' for host in ['www.ksnnhbj.com', 'm.hkybqufgh.com', 'm.sizhengxt.com', 'm.9zhoukj.com', 'm.jiabaide.cn']}),
}
BLOCKS = {
    'xuenai': '整个包使用字符串解码与控制流混淆，无法确认真实入口、启动行为和安全上游白名单；未执行。',
    'ggboomla': '服务启动及模块入口使用字符串表混淆，宿主和网络行为不可充分审核；未执行。',
    'androwsc': 'ad 包的已识别影视模块为成人专用，没有普通影视/动画候选；未执行、不访问其上游。',
    'fangkuia': '内建影视候选以成人模块为主，短剧名称也不能证明普通内容；通用采集模块依赖用户配置，没有审核通过的普通候选，未执行。',
}

HOST = r'''
'use strict';
const fs=require('node:fs'), http=require('node:http'), https=require('node:https'), net=require('node:net'), tls=require('node:tls'), path=require('node:path');
const policy=JSON.parse(fs.readFileSync('policy.json','utf8'));
const audit=(event)=>fs.appendFileSync('network.jsonl',JSON.stringify(event)+'\\n');
const allowed=(host,protocol)=>Object.hasOwn(policy.hosts,host)&&policy.hosts[host]===protocol;
const deny=()=>{ const e=Error('出站目标或方式未获静态审核许可');e.code='CAT_NETWORK_DENIED';throw e; };
const originalListen=net.Server.prototype.listen;
net.Server.prototype.listen=function(options,...args){
 if(typeof options!=='object'||!options) { if(typeof options==='number') return originalListen.call(this,{host:'127.0.0.1',port:0},...args.filter(x=>typeof x==='function')); return deny(); }
 return originalListen.call(this,{...options,host:'127.0.0.1',port:0},...args);
};
for(const [mod,protocol] of [[http,'http:'],[https,'https:']]){
 const original=mod.request;
 mod.request=function(options,...args){
  let o=options;
  if(typeof options==='string'||options instanceof URL){const u=new URL(options);o={protocol:u.protocol,hostname:u.hostname,port:u.port,path:u.pathname+u.search};}
  if(!o||typeof o!=='object')return deny();
  const host=String(o.hostname||o.host||'');
  if(!allowed(host,protocol)||o.socketPath||o.auth||(o.port&&Number(o.port)!==(protocol==='https:'?443:80))) {audit({event:'denied',host:host.replace(/[^a-zA-Z0-9.:-]/g,'').slice(0,100),protocol});return deny();}
  const pathname=String(o.path||'/').split('?')[0];
  audit({event:'request',host,protocol,path:pathname.replace(/[0-9a-f]{16,}/gi,'[脱敏]').slice(0,180)});
  const req=original.call(this,{...o,rejectUnauthorized:true},...args);
  req.setTimeout(10000,()=>req.destroy(Error('上游请求超时')));
  req.on('response',r=>audit({event:'response',host,status:r.statusCode}));
  req.on('error',e=>audit({event:'error',host,code:e.code||e.name}));return req;
 };
 mod.get=function(...args){const req=mod.request(...args);req.end();return req;};
}
// 普通 fetch 可能绕过 http.request；仅允许已审阅候选使用上述 HTTP(S) 适配器。
globalThis.fetch=async()=>deny();
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 let o=args[0];if(Array.isArray(o))o=o[0];
 if(!o||typeof o!=='object'||o.path)return deny();
 const host=String(o.hostname||o.host||'');
 if(!Object.hasOwn(policy.hosts,host))return deny();return connect.apply(this,args);
};
const tlsConnect=tls.connect;
tls.connect=function(options,...args){if(!options||typeof options!=='object'||!allowed(String(options.servername||options.host||''),'https:'))return deny();return tlsConnect.call(this,{...options,rejectUnauthorized:true},...args);};
const http2=require('node:http2');http2.connect=deny;
const dgram=require('node:dgram');dgram.createSocket=deny;
globalThis.catDartServerPort=()=>0;
globalThis.catServerFactory=(handler)=>{
 const server=http.createServer((req,res)=>{
  if(!policy.keys.some(k=>new RegExp('^/spider/'+k+'/3/(init|search|detail|play)$').test(req.url.split('?')[0]))){res.writeHead(403);res.end();return;}
  handler(req,res);
 });
 server.once('listening',()=>fs.writeFileSync('ready.json',JSON.stringify(server.address())));return server;
};
const errorEvidence=e=>({code:e?.code||e?.name||'unknown',permission:e?.permission||null,resource:e?.resource?String(e.resource).replaceAll(process.cwd(),'[临时目录]').replace(/[A-Za-z]:[^\r\n]*?(?=[/\\][^/\\]*$)/g,'[外部路径]'):null,frame:String(e?.stack||'').split('\n').filter(x=>x.includes('source.cjs')).slice(0,2).map(x=>x.replaceAll(process.cwd(),'[临时目录]'))});
process.on('uncaughtException',e=>audit({event:'uncaught',...errorEvidence(e)}));
process.on('unhandledRejection',e=>audit({event:'rejection',...errorEvidence(e)}));
const source=require(path.join(process.cwd(),'source.cjs'));
if(typeof source.start!=='function'||typeof source.stop!=='function')throw Error('真实CommonJS导出不匹配');
fs.writeFileSync('exports.json',JSON.stringify(Object.keys(source)));
Promise.resolve(source.start({color:[],quark:{cookie:''},uc:{cookie:'',token:''},ali:{token:''},baidu:{cookie:''}})).catch(e=>{audit({event:'start_error',...errorEvidence(e)});process.exit(2);});
setTimeout(()=>{Promise.resolve(source.stop()).finally(()=>process.exit(0));},110000);
'''


def static_review(text, key):
    needles = ['module.exports=', 'serverFactory:catServerFactory', 'catDartServerPort', 'host:"0.0.0.0"', 'require("node:module")', 'createRequire', 'new Function', 'eval(']
    evidence = []
    for needle in needles:
        index = text.find(needle)
        if index >= 0:
            evidence.append({'token': needle, 'offset': index, 'line': text.count('\n', 0, index)+1})
    requires = sorted(set(re.findall(r'require\(["\']([^"\'\n]+)["\']\)', text)))
    candidates = AUDITED.get(key, [None, [], {}])[1]
    candidate_evidence = []
    for candidate in candidates:
        token = 'key:"'+candidate+'"'
        index = text.find(token)
        candidate_evidence.append({'source':candidate,'meta_offset':index,'meta_line':text.count('\n',0,index)+1 if index>=0 else None})
    for host in AUDITED.get(key, [None, [], {}])[2]:
        index = text.find(host)
        candidate_evidence.append({'upstream_host':host,'offset':index,'line':text.count('\n',0,index)+1 if index>=0 else None})
    return {'evidence': evidence, 'candidate_evidence':candidate_evidence, 'requires': requires,
            'dangerous_token_counts': {n: text.count(n) for n in ['child_process', 'execSync', 'spawn(', 'eval(', 'new Function', 'worker_threads', 'createRequire']},
            'commonjs_export_marker': 'module.exports=' in text,
            'host_callbacks': [n for n in ['catServerFactory', 'catDartServerPort', 'messageToDart'] if n in text],
            'review_scope': '审阅导出/启动函数、候选模块和上游；标记计数只用于定位，不等于恶意判定。HTML弹幕spawn不是子进程。路由/AJV内置动态编译不等于远程脚本可执行。',
            'dependencies': '不安装依赖；require 缺失直接报告运行失败。Node权限禁止子进程、Worker、原生插件及临时目录外读写。',
            'startup_review': '已审核可读启动函数；不授予宿主配置/凭据。启动可能进行其他模块检查，所有非候选网络目标拒绝并记录，因而会影响启动兼容性。' if key in AUDITED else BLOCKS[key],
            'approved_runtime_fingerprint': AUDITED.get(key, [None])[0]}


def runtime(report, data, policy):
    keys, hosts = policy[1], policy[2]
    report['candidates'] = [{'source':key,'stages':{stage:'not_run' for stage in ['init','search','detail','play']},'requests':[],'failure_reason':'宿主尚未就绪'} for key in keys]
    report['network_policy'] = {'hosts': hosts, 'note': '仅静态定位候选API；拒绝其他目标、原始socket/http2/UDP及fetch；不允许媒体域名，不抓取媒体。网络守卫不是OS安全沙箱。'}
    report['status'] = 'runtime_failed'
    with tempfile.TemporaryDirectory(prefix='lunatv-cats-') as tmp:
        directory = Path(tmp)
        (directory / 'source.cjs').write_bytes(data)
        (directory / 'host.cjs').write_text(HOST.replace("'\\\\n'", "'\\n'"), encoding='utf-8')
        (directory / 'policy.json').write_text(json.dumps({'keys': keys, 'hosts': hosts}), encoding='utf-8')
        env = {'SystemRoot': os.environ.get('SystemRoot', 'C:/Windows'), 'TEMP': tmp, 'TMP': tmp, 'NODE_ENV': 'development'}
        cmd = [str(SINGLE.NODE), '--permission', '--allow-fs-read='+tmp, '--allow-fs-write='+tmp, '--no-addons', '--max-old-space-size=384', str(directory/'host.cjs')]
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(cmd, cwd=tmp, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            report['runtime'] = {'started': True, 'source_unchanged': True, 'minimal_environment': True, 'node_permission': True}
            try:
                deadline = time.monotonic()+35
                while not (directory/'ready.json').exists():
                    if process.poll() is not None:
                        raise RuntimeError('Node在监听前退出')
                    if time.monotonic()>deadline:
                        raise TimeoutError('35秒启动期限内未就绪')
                    time.sleep(.1)
                address = json.loads((directory/'ready.json').read_text())
                report['runtime']['address'] = address
                if address.get('address') != '127.0.0.1':
                    raise RuntimeError('实际监听不符合本机限制')
                if (directory/'exports.json').exists():
                    report['runtime']['exports'] = json.loads((directory/'exports.json').read_text())
                base = 'http://127.0.0.1:'+str(address['port'])
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                report['status'] = 'upstream_failed'
                report['candidates'] = []
                for key in keys:
                    candidate = {'source': key, 'stages': {stage:'not_run' for stage in ['init','search','detail','play']}, 'requests': []}
                    report['candidates'].append(candidate)
                    def call(stage, body):
                        evidence = {'stage': stage, 'method': 'POST', 'path': '/spider/'+key+'/3/'+stage, 'request': {'wd': '熊出没', 'page': 1} if stage=='search' else ({} if stage=='init' else {'id': '[已脱敏]'})}
                        candidate['requests'].append(evidence)
                        start = time.monotonic()
                        try:
                            request = urllib.request.Request(base+evidence['path'], data=json.dumps(body).encode(), headers={'Content-Type':'application/json'})
                            try:
                                response = opener.open(request, timeout=15)
                            except SINGLE.urllib.error.HTTPError as error:
                                response = error
                            with response:
                                raw = response.read(2_000_001)
                                evidence.update({'http_status':response.status,'bytes':len(raw)})
                                if len(raw)>2_000_000:
                                    raise ValueError('响应超过限制')
                                obj = json.loads(raw)
                                evidence['response'] = {'keys':list(obj) if isinstance(obj,dict) else [],'list_count':len(obj.get('list',[])) if isinstance(obj,dict) else None}
                                if response.status>=400:
                                    candidate['stages'][stage] = 'http_error'
                                    if isinstance(obj,dict):
                                        evidence['error_code'] = str(obj.get('code',''))[:80]
                                    return None
                                candidate['stages'][stage] = 'ok'
                                return obj
                        except Exception as error:
                            candidate['stages'][stage] = 'failed'
                            evidence['error_type'] = type(error).__name__
                            return None
                        finally:
                            evidence['elapsed_ms'] = round((time.monotonic()-start)*1000)
                    call('init',{})
                    result = call('search',{'wd':'熊出没','page':1})
                    if not isinstance(result,dict) or not result.get('list'):
                        candidate['failure_reason'] = '搜索未返回有效列表，不能进入详情和解析阶段'
                        continue
                    item = next((x for x in result['list'] if re.fullmatch(r'熊出没[\u4e00-\u9fff0-9·：:之\s-]*',str(x.get('vod_name','')))),None)
                    if not item:
                        candidate['failure_reason'] = '搜索结果没有明确匹配儿童动画的记录'
                        continue
                    detail = call('detail',{'id':item.get('vod_id')})
                    if not isinstance(detail,dict) or not detail.get('list'):
                        candidate['failure_reason'] = '详情无有效记录'
                        continue
                    vod = detail['list'][0]
                    if '熊出没' not in str(vod.get('vod_name','')):
                        candidate['failure_reason'] = '详情标题校验失败'
                        continue
                    first = str(vod.get('vod_play_url','')).split('$$$')[0].split('#')[0].split('$',1)
                    flags = str(vod.get('vod_play_from','')).split('$$$')
                    if len(first)!=2 or not first[1]:
                        candidate['failure_reason'] = '详情没有有效播放ID'
                        continue
                    play = call('play',{'id':first[1],'flag':flags[0]})
                    if isinstance(play, dict):
                        from urllib.parse import urlsplit
                        url = play.get('url')
                        def valid_http(value):
                            if not isinstance(value,str) or not value or value!=value.strip() or any(c.isspace() for c in value):
                                return False
                            try:
                                parsed=urlsplit(value)
                                return parsed.scheme in ('http','https') and bool(parsed.hostname) and not parsed.username and not parsed.password
                            except ValueError:
                                return False
                        pairs = report['package']=='lmentor' and isinstance(url,list) and len(url)>=2 and len(url)%2==0 and all(isinstance(label,str) and label.strip() for label in url[::2]) and all(valid_http(value) for value in url[1::2])
                        valid_url = valid_http(url) or pairs
                        direct = type(play.get('parse')) is int and play['parse'] == 0
                        candidate['play'] = {'parse': play.get('parse'), 'url_present': bool(url), 'http_url_valid': bool(valid_url), 'url_kind':type(url).__name__, 'url_count':len(url)//2 if pairs else int(valid_http(url)), 'normalization':'label_url_pairs' if pairs else 'none', 'media_fetched': False}
                        if direct and valid_url:
                            candidate['stages']['play'] = 'resolved'
                            report['status'] = 'play_resolved'
                        else:
                            candidate['stages']['play'] = 'requires_parse' if play.get('parse') in (1, '1') else 'response_received'
                            candidate['failure_reason'] = 'play需要进一步解析或没有明确parse=0与有效HTTP(S)地址'
                            if report['status']!='play_resolved':
                                report['status']='play_requires_parse' if candidate['stages']['play']=='requires_parse' else 'play_response_received'
                    else:
                        candidate['failure_reason'] = 'play未返回有效响应'
            except Exception as error:
                report['failure_reason'] = str(error)
                report['failure_type'] = type(error).__name__
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=5)
                report['runtime'].update({'exit_code':process.returncode,'process_stopped':process.poll() is not None})
                log.seek(0)
                output = log.read(256000).decode('utf-8',errors='replace')
                report['runtime']['error_codes'] = sorted(set(re.findall(r'\b(?:ERR_[A-Z_]+|MODULE_NOT_FOUND|ENOTFOUND|ECONNRESET|ETIMEDOUT|CAT_NETWORK_DENIED)\b',output)))
                report['runtime']['registered_count'] = len(set(re.findall(r'Register spider: (/spider/[a-zA-Z0-9_/-]+)',output)))
                report['runtime']['missing_modules'] = sorted(set(re.findall(r"Cannot find module ['\"]([a-zA-Z0-9_@./-]+)['\"]",output)))
                report['runtime']['permission_log_tokens'] = [token for token in ['FileSystemRead','FileSystemWrite','.env','Access to this API has been restricted'] if token in output]
                if 'ERR_ACCESS_DENIED' in report['runtime']['error_codes']:
                    report['failure_reason'] = report.get('failure_reason','运行失败')+'；启动日志含 ERR_ACCESS_DENIED，未放宽权限；具体日志仅保存脱敏标记'
                report['runtime']['permission_resources'] = sorted(set(re.findall(r"permission: ['\"]([a-zA-Z]+)['\"]",output)))
                if report['runtime']['permission_resources']:
                    report['failure_reason'] = report.get('failure_reason','运行失败')+'；Node权限拒绝：'+', '.join(report['runtime']['permission_resources'])
                if directory.joinpath('network.jsonl').exists():
                    events=[]
                    for line in directory.joinpath('network.jsonl').read_text(encoding='utf-8').splitlines()[:250]:
                        try:
                            events.append(json.loads(line))
                        except ValueError:
                            pass
                    report['runtime']['network_evidence']=events
                    denied_permissions=[e for e in events if e.get('code')=='ERR_ACCESS_DENIED']
                    if denied_permissions:
                        report['failure_reason']=report.get('failure_reason','运行失败')+'；权限拒绝：'+', '.join(sorted({str(e.get('permission') or '未知') for e in denied_permissions}))+'；未放宽临时目录外读取'
                if report['status']!='play_resolved' and not report.get('failure_reason'):
                    report['failure_reason']='候选未完成搜索→详情→play闭环；以逐阶段及网络HTTP证据为准'
    report['cleanup']={'process_stopped':True,'temporary_directory_removed':not directory.exists(),'raw_runtime_log_retained':False}


def main():
    only_lmentor = sys.argv[1:] == ['--only-lmentor']
    previous_report = json.loads((OUT/'cat-sources-verification.json').read_text(encoding='utf-8')) if only_lmentor else None
    selected = [entry for entry in PACKAGES if entry[0]=='lmentor'] if only_lmentor else PACKAGES
    report = {'schema_version':1,'created_at':datetime.now(timezone.utc).isoformat(),'scope':'仅备用地址；独立验证，不改src，不安装依赖，不提交部署；不下载媒体','packages':[]}
    with tempfile.TemporaryDirectory(prefix='lunatv-cat-review-') as tmp:
        directory=Path(tmp)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            packages=list(pool.map(lambda entry:collect(entry,directory),selected))
        report['packages']=packages
        for package in packages:
            key=package['package']
            package['tested_at']=report['created_at']
            if package['status']!='awaiting_static_review':
                continue
            data=(directory/(key+'.js')).read_bytes()
            package['static_review']=static_review(data.decode('utf-8'),key)
            package['tested_this_run']=False
            if key in BLOCKS:
                package['status']='no_general_candidate' if key in ['fangkuia','androwsc'] else 'static_blocked'
                package['failure_reason']=BLOCKS[key]
            elif package['download']['sha256']!=AUDITED[key][0]:
                package['status']='fingerprint_changed'
                package['failure_reason']='源码指纹已改变，必须重新静态审核；禁止执行'
            else:
                package['tested_this_run']=True
                try:
                    runtime(package,data,AUDITED[key])
                except Exception as error:
                    package['status']='runtime_failed'
                    package['failure_reason']='独立运行器异常：'+type(error).__name__
                    package['cleanup']={'temporary_directory_context_exited':True}
            print(key,package['status'],flush=True)
    report['source_download_cleanup']={'temporary_directory_removed_after_run':not directory.exists(),'remote_js_retained':False}
    if only_lmentor:
        fresh=report['packages'][0]
        fresh['previous_run']={'tested_at':previous_report['created_at'],'status':next(p['status'] for p in previous_report['packages'] if p['package']=='lmentor'),'note':'此前仅接受字符串URL，本次按已静态确认的标签/URL成对数组严格校验'}
        report['packages']=[fresh if p['package']=='lmentor' else p for p in previous_report['packages'] if p['package']!='nitan']
        for package in report['packages']:
            if package['package']!='lmentor':
                package['tested_at']=package.get('tested_at',previous_report['created_at'])
                package['retained_previous_run']=True
                package['tested_this_run']=False
                if package['package'] in ['fangkuia','androwsc']:
                    package['status']='no_general_candidate'
        report['previous_run_at']=previous_report['created_at']
        report['scope']+='；本次仅复测lmentor，其他包保留前次证据，以各包tested_at为准'
    previous=OUT/'cat-source-verification.json'
    if previous.exists():
        prior=json.loads(previous.read_text(encoding='utf-8'))
        report['packages'].append({'package':'nitan','tested_this_run':False,'status':prior['status'],'previous_created_at':prior['created_at'],'download':prior.get('download'),'play':prior.get('play'),'evidence_file':'outputs/cat-source-verification.json','note':'仅汇总先前泥潭结果，非本次复测'})
    report['summary']={status:sum(p['status']==status for p in report['packages']) for status in sorted({p['status'] for p in report['packages']})}
    OUT.mkdir(exist_ok=True)
    (OUT/'cat-sources-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['备用猫源逐包验证报告', '时间：'+report['created_at'], report['scope'], '说明：play_resolved仅证明解析返回地址，不等于媒体播放或LunaTV前端集成成功。', '隔离：Node22权限限制临时cwd；无凭据环境；禁止子进程/Worker/原生插件；强制127.0.0.1随机端口；JS网络守卫不是OS安全沙箱。','']
    for package in report['packages']:
        lines.extend([package['package']+'：'+package['status']+'；本次执行='+str(package.get('tested_this_run',False)), '  '+package.get('failure_reason',package.get('note',''))])
        for candidate in package.get('candidates',[]):
            lines.append('  候选 '+candidate['source']+'：'+json.dumps(candidate['stages'],ensure_ascii=False)+'；'+candidate.get('failure_reason',''))
    lines.extend(['','完整脱敏证据：',json.dumps(report,ensure_ascii=False,indent=2)])
    (OUT/'cat-sources-verification.txt').write_text('\n'.join(lines),encoding='utf-8')
    print(json.dumps(report['summary'],ensure_ascii=False))


if __name__ == '__main__':
    main()
