# 独立源运行网关

需要 Node.js 22。此目录只使用 Node 内置模块，不随仓库分发来源脚本、DEX 或 so，也不自动下载或更新来源代码。只运行用户有权使用且已审查、固定 SHA256 的本地 CommonJS 猫源包。SHA256 只能保证文件未变，不证明来源代码安全。

## 配置和启动

1. 复制 `config.example.json` 为部署目录的 `config.json`，保留需要的 sites。`key` 是应用使用的注册 ID；`upstreamKey` 是猫源包内部的 ID。`scriptPath` 与 `workDirectory` 相对于配置文件目录解析。脚本需要 `.cjs` 扩展名或 CommonJS 包环境。
2. 在独立目录准备审查过的源包，运行 `node -e "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" /sources/reviewed-source.cjs` 获取固定指纹，将其填入配置。不要盲目自动接受更新后的指纹。
   - `scriptUrl`（可选）：显声明的远程来源地址。仅当 `scriptPath` 指向的本地文件不存在时，网关会按该地址下载一次（8MB 上限、30 秒超时、禁止重定向），并强制校验 `sha256` 指纹；不匹配则删除下载文件并拒绝启动。文件落地后网关不再访问 `scriptUrl`，版本永远由指纹钉死；更新源必须由运维核对新指纹、修改配置并清理旧文件。`scriptUrl` 不改变"审查后才可运行"的原则：指纹仍是运维确认过的值。
3. 在服务进程环境设置 `RUNNER_CONFIG`（配置绝对路径）、`RUNNER_TOKEN`（至少 24 字符随机密钥），然后执行 `node runners/gateway.mjs`。默认监听 `127.0.0.1:8787`；`HOST`、`PORT` 可在服务端设置。跨机器访问需自行配置经过鉴权的 HTTPS 反向代理，或使用受信私网。

网关按需创建猫源子进程。子进程以 `catServerFactory(handler)` 创建原生 HTTP Server，强制监听 loopback 随机端口；提供 `catDartServerPort() => 0`，再验证 `start/stop` 导出并显式调用 `start(config)`。该契约来自项目现有验证脚本的真实宿主，不依赖来源自动启动环境变量。启动前父、子进程分别校验文件 SHA256；不要在运行中修改源目录。Dart 专用账号或交互动作可能不可用。

原包外部依赖通过服务端 `runtime.dependencyDirectory` 指向专用 `node_modules`，网关将此受控绝对目录设为子进程 `NODE_PATH`，不会继承机器的 `NODE_PATH`。未指定时不设置 `NODE_PATH`，也不继承宿主环境值；源包自身相邻的 `node_modules` 仍遵循 Node 常规解析，均应只读且经过审查。已核验猫源引用 `ajv`、`ajv-formats`、`fast-json-stringify`。本地部署需自行准备这些依赖，网关运行时不安装、不执行来源包安装脚本。依赖缺失或导出不匹配将返回 `runtime_unavailable`。工作目录用于来源自身存储，不能与网关配置、凭据目录共享。来源进程不继承 `RUNNER_TOKEN`、`CSP_BRIDGE_TOKEN`、`NODE_OPTIONS`，日志不透传来源自由文本。

子进程和 Node 参数不是 OS 沙箱。来源代码仍具有其服务用户的文件、网络能力；生产环境应以无额外凭据的独立非特权用户/容器运行，只读挂载源目录，仅开放专属数据目录。不要挂载项目、用户主目录、Docker socket 或 Android ADB 端口。当前网关限制 16 个并发请求、64KiB 请求和 4MiB 上游 JSON；上游超时 20 秒，禁止重定向。

## HTTP 接口

全部接口，包括 health，都要求 `Authorization: Bearer <RUNNER_TOKEN>`，不支持 query token，也不向浏览器提供 CORS 授权。应用后端代理请求，密钥不能放进 `NEXT_PUBLIC_*`、浏览器、导出配置或请求日志。

- `GET /health`：返回协议版本、能力和逐源运行状态，不包含 URL、指纹或凭据。`catjs: true` 表示网关具备宿主协议，不保证每个包已启动；逐源状态为 `not_started` 或 `started`。
- `POST /spider/:key/3/init`：`{}`，实际初始化固定注册源并返回 `capabilities`；禁止客户端传入注册元数据。初始化成功后缓存，后续动作也会自动初始化。
- `POST /spider/:key/3/search`：`{"wd":"关键词","page":1}`。
- `POST /spider/:key/3/detail`：`{"id":"原始影片ID"}`，亦可传字符串数组。
- `POST /spider/:key/3/play`：`{"id":"不透明播放ID","flag":"原始线路标识"}`。

`/v1/sites/:key/{init|search|detail|play}` 保留为兼容别名。应用服务端设置 `SOURCE_RUNNER_URL` 为本网关基地址，`SOURCE_RUNNER_TOKEN` 与网关的 `RUNNER_TOKEN` 相同；若应用配置以环境变量名引用凭据，该引用指向 `SOURCE_RUNNER_TOKEN`。它与 Android 内部桥的 `CSP_BRIDGE_TOKEN` 是两个独立密钥。

网关只接受已注册 key。客户端无法指定或覆盖脚本地址、JAR、桥接地址、ext。首次调用先请求内部 `/spider/:upstreamKey/3/init`，然后转发既有 `/spider/:upstreamKey/3/{search|detail|play}`；上游 JSON 原样返回。播放 `parse`、`header`、不透明 ID 和线路不作猜测性处理。`parse=1` 仍需应用端真实解析流程，不能当直连成功。

错误为 `{"error":"code"}`，不会回显原始上游消息：401 `unauthorized`，404 `unknown_site/not_found`，400 参数错误，413 `body_too_large`，429 `runner_busy`，503 `runtime_unconfigured/runtime_unavailable/script_hash_mismatch/script_download_failed/unsupported_runtime`，502 `source_error/invalid_upstream_response`。

## Android CSP 桥接要求

此网关仅转发 Android 桥，不包含现成桥接 APK。用户必须另行提供真正的 Android 宿主：ARM64 Android 手机/盒子，或适配内核的 Linux ReDroid Android 容器。目标源含 Android DEX 和 ARM 原生库，普通 Node/JDK/Docker 镜像不能执行；本目录 Dockerfile 也不会提供 Android。x86 Android 的 ARM 翻译兼容性需实测。

在网关环境配置 `CSP_BRIDGE_URL` 和 `CSP_BRIDGE_TOKEN`。URL 是不带凭据、query 和 hash 的 HTTP(S) 基地址；桥接与网关之间使用私网或 HTTPS。Android 桥必须实现：

- `POST /spider/:key/3/init`，Bearer 桥接密钥鉴权。接收固定服务端注册信息 `{siteKey,type,api,ext,spider,parses,flags,baseUrl}`，真实下载并校验授权 JAR、构建 Android Context/DexClassLoader、实例化并调用 `Spider.init(context, ext)`；成功返回 `{"capabilities":{"csp":true}}`。网关不执行或下载 JAR。桥必须自行限制可注册源，不把此接口作为任意公开代码执行入口。
- `POST /spider/:key/3/search` 接收 `{wd,page}`，映射 `searchContent`；`detail` 接收 `{id}`，映射 `detailContent`；`play` 接收 `{id,flag}`，映射 `playerContent`。详情和搜索返回 MacCMS 字段，播放返回真实 `{url,parse,header}` 等数据。
- 桥负责将 Android 本机代理地址转换为实际可达、受限且鉴权的媒体中继，正确处理 Range、MIME、m3u8 嵌套相对地址。此网关只转发 JSON，不实现媒体隧道；检测到 loopback 播放地址时明确返回 502 `local_media_proxy_required`，不会直接发给浏览器。需要浏览器无法提供的桥接 token 的地址也将无法播放，不能声称已完整支持。

桥未配置时 CSP 请求始终 503 `runtime_unconfigured`；health 的 CSP 状态明确未配置。桥已配置但未初始化时为 `unverified`，只有成功初始化并确认能力后 `capabilities.csp` 才为 true；此能力不等于目标源搜索/播放已验收。来源宿主校验或设备限制导致失败时应据实返回错误，不绕过权限。ADB 不能暴露公网。Vercel 无法直连家庭私网，应让运行器与 Android 同网，并为应用后端提供经过鉴权的可达 HTTPS 入口。

## 容器

从仓库根目录执行 `docker build -f runners/Dockerfile -t lunatv-runner .`。镜像包含原创网关、宿主及显式固定版本的 `ajv@8.17.1`、`ajv-formats@3.0.1`、`fast-json-stringify@6.0.1`（安装禁用生命周期脚本），不包含源包、Android 或凭据。容器配置应显式设置 `dependencyDirectory` 为镜像内 `/opt/lunatv-runner/node_modules`，或审查过的自备依赖目录；网关不会继承镜像环境的 `NODE_PATH`。部署时只读挂载配置与已准备的来源环境到 `/sources`，可写挂载专属目录到 `/data`，通过服务管理器注入密钥；将 `RUNNER_CONFIG` 指向实际配置位置。上述三项以外的来源依赖需要随用户自己的审查构建准备，不能假定基础镜像自带；本地执行的兼容性不等于容器构建已验收。

示例发布端口应仅绑定本机，如 `-p 127.0.0.1:8787:8787`，由 HTTPS 反向代理提供外部入口。不要使用 privileged；ReDroid 若另行部署需要独立的安全与运行配置。

## 验证

固定新版包的受限真实验收可执行 `python runners/verify-reviewed-cat.py`：只接受既有审查 SHA256 `00b82deb95b35b4251c08e810b432cb4956ccaf77b703d5b21379388cfc7784b`，下载文件不匹配即拒绝；临时复制网关并仅测试注入原验证脚本完整网络守卫和 Node 目录权限，限制 `rebo`、`v.rbotv.cn:80`，禁 fetch/http2/UDP，不继承 NODE_PATH/凭据，不抓媒体。报告只向标准输出脱敏状态，临时脚本、来源包、数据与网络日志自动删除。该测试专用隔离策略不会自动应用于生产网关，不能据此把生产进程视为沙箱。

执行 `node --test runners/gateway.test.mjs`。测试仅执行仓库原创假宿主和本机 HTTP 桥，覆盖鉴权、固定注册、start 宿主回调、动作参数映射、指纹错误、上游错误、Android 注册能力确认；不下载或执行第三方来源代码，不访问媒体。
