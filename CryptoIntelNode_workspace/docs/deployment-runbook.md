# Crypto Intel Node 部署运行手册

本手册只描述待授权操作，不表示服务已经部署、注册或在线。目标运行身份固定为
`crypto-intel:crypto-intel`。

## 四层门禁

| 层级 | 当前状态 | 放行条件 |
|---|---|---|
| `local-ready` | 可本地检查；Linux 工具缺失项为 `blocked-linux` | 模板静态检查、Node 入口语法和本地探针通过 |
| `deploy-ready` | `blocked-external` | 主机、DNS、TLS 与部署操作获授权并完成核验 |
| `register-ready` | `blocked-external` | 版本、provider、Agent/Service identity 均获批并核验 |
| `live-completed` | `blocked-external` | 部署、注册、平台状态和公网业务接口均由真实命令验证 |

`systemd-analyze`、`systemctl`、`nginx` 等 Linux 工具若当前环境不存在，只记录
`blocked-linux`，不得把未执行检查写成通过。

统一机器验收入口为 `node scripts/verify-readiness.js --level <level>`。`local` 只证明离线制品可验收；`data/payment/economics/deploy/register/a2a-live` 必须分别取得真实外部证据，跳过、synthetic fixture、health 200、402 challenge 或 testnet 结果都不能放行。

## 固定布局

- 发布目录：`/opt/crypto-intel-node/releases/<git-sha>`
- 当前版本：`/opt/crypto-intel-node/current`，仅用原子符号链接切换
- 持久状态：`/home/crypto-intel/.local/state/crypto-intel-node`
- 环境文件：`/home/crypto-intel/.config/crypto-intel-node/runtime.env`
- API：单进程监听 `127.0.0.1:8787`
- A2A job：`/home/crypto-intel/.local/state/crypto-intel-node/a2a/jobs/*/ready`

环境文件必须归 `crypto-intel:crypto-intel` 所有且权限为 `0600`。发布和回滚均保留
state、runtime.env 与 deliverable。

## install（待授权）

1. 创建专用用户/组及固定目录，确保 state 和 config 目录仅专用用户可写。
2. 将获批版本安装到新的 `releases/<git-sha>`，在该目录安装锁定依赖。
3. 获得授权后，用以下命令安装 runtime.env，再填写获批值：

   ```sh
   install -o crypto-intel -g crypto-intel -m 0600 deploy/runtime.env.example /home/crypto-intel/.config/crypto-intel-node/runtime.env
   stat -c '%a %U %G' /home/crypto-intel/.config/crypto-intel-node/runtime.env
   ```

   `stat` 的目标结果必须为 `600 crypto-intel crypto-intel`；仓库中的 example
   保持普通模板权限，不作为运行时密钥文件直接使用。
4. 安装 API、worker、path 三个 unit；先做 Linux unit 校验。
5. 参数化 Nginx 的 DNS 主机名和 TLS 证书路径，执行配置校验。
6. 以临时链接指向新版本，再用一次原子重命名切换 `current`。
7. 执行 daemon reload，启动 API 和 path unit；worker 由 path unit 触发。

provider drop-in 的 `.example` 只能用于审阅。在版本、provider 入口/参数及 identity
核验完成前，它保持 `blocked-external`；禁止复制、enable 或 restart 该示例。

## health（待授权）

先且只在主机本地检查：

```text
curl -i http://127.0.0.1:8787/healthz
curl -i http://127.0.0.1:8787/readyz
```

health 应返回 200；真实外部门禁未放行时 ready 应返回 503。Nginx 只允许 HTTPS 443
上的 `/v1/token-risk-score`，其他路径返回 404；不得公开 health、ready 或 A2A。

## register（待授权）

先核对已部署 commit 与批准版本一致，再核验 provider 文件及 Agent/Service identity。
只有三项一致，才可申请生成正式 drop-in 并执行平台注册步骤。不得从 `.example` 直接
生成运行态配置。

平台注册的完整顺序以 `docs/registration-runbook.md` 为唯一清单；部署和公网 HTTPS 未真实完成前不得开始注册。

## live verification（待授权）

以下命令类别均须逐项获授权，且输出须留作对应门禁证据：

- DNS 查询与 TLS 握手/证书检查
- `systemctl daemon-reload`、unit enable/start/status 与日志检查
- `nginx -t`、reload 与 HTTPS 业务路径请求
- `okx-a2a daemon status`
- `okx-a2a agent refresh --json`
- `onchainos agent setup`
- `onchainos agent status`

只有 localhost health、systemd、Nginx、daemon status、agent refresh、setup/status 和
公网业务接口均完成真实验证后，才能把 `live-completed` 从 `blocked-external` 放行。

## rollback（待授权）

1. 找到上一已知良好的 `releases/<git-sha>`。
2. 创建指向该版本的临时符号链接，以原子重命名替换 `current`。
3. restart API；path unit 保持监控，按需检查 worker 失败记录。
4. 重复 localhost health，再复核 Nginx 业务路径。

回滚只切换 `current`。不得删除、重建或替换持久 state、runtime.env、A2A jobs、
deliverable，也不得覆盖保留的发布目录。
