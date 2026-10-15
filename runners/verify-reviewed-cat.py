"""仅验证已审核固定猫源：临时网关、原网络守卫、Node目录权限，不抓媒体。"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SHA = '00b82deb95b35b4251c08e810b432cb4956ccaf77b703d5b21379388cfc7784b'
SPEC = importlib.util.spec_from_file_location('reviewed_batch', ROOT / 'scripts/verify-cat-sources.py')
BATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BATCH)

HARNESS = r'''
import {createGateway} from './gateway.mjs';
const token='temporary-verification-token-no-user-secrets';
const gateway=await createGateway({token,configDirectory:process.cwd(),config:{
 runtimes:{reviewed:{scriptPath:'source.cjs',sha256:process.env.REVIEWED_SHA,workDirectory:'.',config:{color:[],quark:{cookie:''},uc:{cookie:'',token:''},ali:{token:''},baidu:{cookie:''}}}},
 sites:[{key:'rebo',kind:'catjs',runtime:'reviewed'}]
}});
const stages={};
try {
 await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${gateway.server.address().port}`;
 async function call(action,body){
  const r=await fetch(`${base}/spider/rebo/3/${action}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const d=await r.json(); stages[action]={status:r.status,ok:r.ok,error:r.ok?undefined:d.error};
  if(!r.ok)throw Error(action); return d;
 }
 await call('init',{});
 const search=await call('search',{wd:'熊出没',page:1});
 const item=(search.list||[]).find(x=>/^熊出没[\u4e00-\u9fff0-9·：:之\s-]*$/.test(String(x.vod_name||'')));
 if(!item)throw Error('no_matching_item');
 const detail=await call('detail',{id:item.vod_id});
 const vod=detail.list?.[0]; if(!vod||!String(vod.vod_name).includes('熊出没'))throw Error('invalid_detail');
 const group=String(vod.vod_play_url||'').split('$$$')[0].split('#')[0];
 const separator=group.indexOf('$'); if(separator<0)throw Error('no_play_id');
 const play=await call('play',{id:group.slice(separator+1),flag:String(vod.vod_play_from||'').split('$$$')[0]});
 stages.play.url_present=!!play.url; stages.play.parse=play.parse;
 console.log(JSON.stringify({status:play.url?'play_resolved':'play_empty',stages,media_fetched:false}));
} catch {console.log(JSON.stringify({status:'verification_failed',stages,media_fetched:false}));process.exitCode=1;}
finally {await gateway.close();}
'''


def main():
    report = {'sha256': SHA, 'gateway_real_package_test': False, 'media_fetched': False}
    try:
        data = BATCH.SINGLE.download('https://9280.kstore.vip/cat/index.js', 15_000_000)
        if hashlib.sha256(data).hexdigest() != SHA:
            raise ValueError('fingerprint_changed')
        with tempfile.TemporaryDirectory(prefix='lunatv-gateway-reviewed-') as tmp:
            directory = Path(tmp)
            (directory / 'source.cjs').write_bytes(data)
            # 完整复用原宿主到cat回调之前的网络限制，不增加任何域名、端口或协议。
            guard = BATCH.HOST.split('globalThis.catDartServerPort=()=>0;')[0]
            guard = guard.replace("'\\\\n'", "'\\n'")
            (directory / 'guard.cjs').write_text(guard, encoding='utf8')
            (directory / 'policy.json').write_text(json.dumps({'keys': ['rebo'], 'hosts': {'v.rbotv.cn': 'http:'}}), encoding='utf8')
            host = (ROOT / 'runners/cat-host.cjs').read_text(encoding='utf8')
            host = host.replace("    source = require(scriptPath);", "    require('./guard.cjs');\n    source = require(scriptPath);")
            (directory / 'cat-host.cjs').write_text(host, encoding='utf8')
            gateway = (ROOT / 'runners/gateway.mjs').read_text(encoding='utf8')
            previous = "execArgv: ['--max-old-space-size=256', '--no-addons']"
            replacement = "execArgv: ['--permission', '--allow-fs-read='+workDirectory, '--allow-fs-write='+workDirectory, '--max-old-space-size=384', '--no-addons']"
            if previous not in gateway:
                raise ValueError('verification_patch_outdated')
            gateway = gateway.replace(previous, replacement)
            start = gateway.index("        const env = { NODE_ENV:")
            end = gateway.index("        const child = fork", start)
            gateway = gateway[:start] + "        const env = {NODE_ENV:'development',SystemRoot:process.env.SystemRoot,TEMP:workDirectory,TMP:workDirectory};\n" + gateway[end:]
            (directory / 'gateway.mjs').write_text(gateway, encoding='utf8')
            (directory / 'verify.mjs').write_text(HARNESS, encoding='utf8')
            env = {'SystemRoot': os.environ.get('SystemRoot', 'C:/Windows'), 'TEMP': tmp, 'TMP': tmp, 'REVIEWED_SHA': SHA}
            result = subprocess.run([str(BATCH.SINGLE.NODE), str(directory / 'verify.mjs')], cwd=tmp, env=env,
                                    capture_output=True, text=True, timeout=100)
            lines = [line for line in result.stdout.splitlines() if line.startswith('{')]
            report.update(json.loads(lines[-1]) if lines else {'status': 'verification_process_failed'})
            report['gateway_real_package_test'] = True
            report['permission'] = '仅临时目录读写；禁子进程、Worker和原生插件；不继承NODE_PATH或用户凭据'
            report['network_policy'] = {'hosts': {'v.rbotv.cn': 'http:'}, 'fetch_http2_udp_denied': True}
            events = directory / 'network.jsonl'
            if events.exists():
                # 只报告类别和目标主机，不保留路径、查询参数或媒体地址。
                text = events.read_text(encoding='utf8').replace('\\n', '\n')
                report['network_events'] = [{k: e[k] for k in ('event', 'host', 'protocol', 'status') if k in e}
                                            for e in [json.loads(line) for line in text.splitlines() if line.strip()]]
        report['temporary_directory_removed'] = not directory.exists()
        report['source_retained'] = False
    except Exception as error:
        report['status'] = 'blocked'
        report['failure_type'] = type(error).__name__
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
