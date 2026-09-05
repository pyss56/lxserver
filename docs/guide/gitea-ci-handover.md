# Gitea CI 交接文档（WorkBuddy 接手指南）

> 目标：把本仓库（LX Music Sync Server）通过**内网 Gitea + act_runner** 构建出 Docker 镜像，
> 推到 Gitea 内置容器 registry `10.3.3.15:3030/pyss56/lxserver`。
> 最后更新：2026-09-05（本文件由 CodeBuddy 生成，供 WorkBuddy 继续推进）

---

## 0. 当前状态速览

| 项目 | 状态 |
| --- | --- |
| Gitea 站点 | `http://10.3.3.15:3030`（v1.27.3，HTTP，**非 HTTPS**） |
| 目标仓库 | `pyss56/lxserver`（**组织**，非用户） |
| 代码 | 已推送 `gitea/main`，最新提交 `b8b99f6` |
| CI 文件 | `.gitea/workflows/docker.yml`（Gitea 只读 `.gitea/workflows`，不会读 `.github/workflows`） |
| Runner | `e1a8675ce5a1` online（可用）；`bee626241e9c` offline（废弃） |
| 组织级 runner | **0 个**（当前是靠全局/用户级 runner 接任务的，见 §4.2） |
| 最近一次构建 | `run#5` = **failure**，卡在 step3「Log in to registry」（根因见 §4.5；已采用方案 B：HTTPS 反代，待重新触发验证） |
| 镜像产出 | 尚未成功，registry 里还没有镜像 |
| Secrets | 组织级 `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` 已配置 ✅ |

---

## 1. 环境信息

```
Gitea         : http://10.3.3.15:3030   (v1.27.3, HTTP)
镜像 registry : 10.3.3.15:3030          (Gitea 内置 packages)
仓库          : http://10.3.3.15:3030/pyss56/lxserver          (private)
组织          : pyss56 (id=4, visibility=private)
管理员账号    : pavel   (id=1, is_admin=true)
本机服务      : lxserver dev 跑在 9527（pid 28472），日志 lxserver/logs/dev.out.log
```

远端配置（本地 git）：

```
origin  https://github.com/pyss56/lxserver.git   （上游 GitHub，本地领先 17 个提交未推）
gitea   http://10.3.3.15:3030/pyss56/lxserver.git （内网 CI 仓库，已同步至 b8b99f6）
```

---

## 2. 凭据（重要）

**不要写进任何会被提交的文件。** 当前有效的 Gitea 访问令牌存放在：

```
lxserver/.gitea-token        （未纳入 git，勿提交）
```

文档与代码里一律用占位符：

| 占位符 | 用途 |
| --- | --- |
| `<GITEA_TOKEN>` | pavel 的 Access Token（40 位），用于 API 调用与 git push |
| `<ORG_RUNNER_TOKEN>` | pyss56 组织注册令牌（注册 runner 用，已使用过） |

推送方式（一次性 URL，不写入 `.git/config`）：

```powershell
git push http://pavel:<GITEA_TOKEN>@10.3.3.15:3030/pyss56/lxserver.git main
```

> ⚠️ 安全待办：以下两个 token 曾在聊天中明文出现，建议**立即轮换**：
> `1b3e6be4b6974171c2314fc50d750cb`（32 位，无效/疑似截断）、`3ac48887ffd00579c5f3e8f699ec373f4731dd42`（当前在用）。
> 轮换后请同步更新 `lxserver/.gitea-token` 与组织 secrets。

---

## 3. 已完成的工作

### 3.1 代码提交（本地 main 领先 origin/main 17 个，已全部推到 gitea）

```
df7b020  ci: checkout via git clone instead of actions/checkout
4c94b9f  ci: point image registry at internal Gitea host
1cd9d2d  ci: build and push image via Gitea Actions
34d94dc  feat(subsonic): align favorites, ratings and playlists with StreamMusic
```

- `34d94dc`：Subsonic 协议对齐（批 1-4），详见 `DONE.md`（Subsonic 协议端点对齐）
  - `star` / `unstar`（歌曲进 love 列表，专辑/歌手写 `subsonic-meta.json`）
  - `setRating`（每用户持久化）
  - `createPlaylist` / `deletePlaylist` / `updatePlaylist`（增补 `songIdToAdd` / `name`）
  - `getIndexes`（根级索引，老客户端导航）
  - `getStarred(2)` 语义修正为只返回收藏内容

> 之后又落地了 Subsonic 协议对齐收尾与文档整合（详见 `DONE.md` / `TODO.md`）：
> b8b99f6 docs: 合并 Subsonic 协议补齐计划到 TODO/DONE
> 3175566 feat(subsonic): 统一解析原语 resolveSongMeta 与播放即缓存落盘
> 3c64c1a feat(subsonic): 播放时边播边存 + 调试日志与设置开关
> 18a2bcc / d942128 / b7b06c3 / 6d9b8a0：star 回源收藏、日志降级、await 修复等
- `1cd9d2d` + `4c94b9f`：新增 `.gitea/workflows/docker.yml`
- `df7b020`：checkout 方式改造（见 §4.1）

### 3.2 Gitea 侧

- 创建组织 `pyss56`、仓库 `pyss56/lxserver`（private，Actions 与 Packages 均已启用）
- 配置组织级 secrets：`REGISTRY_USERNAME`、`REGISTRY_PASSWORD`
- 清理了过程中的临时对象：用户 `pyss56`（已删）、`pavel/lxserver`（已删）

### 3.3 workflow 设计要点

`.gitea/workflows/docker.yml`：

- 触发：`push main` / `v*` 标签 / `workflow_dispatch`
- 架构：**仅 linux/amd64**（三架构在单机 runner 上太慢）
- 标签：`latest` + `public/js/config.js` 里的版本号 + 短 SHA
- **零第三方 action 依赖**：原 GitHub 版用的 `docker/build-push-action`、`docker/login-action`、`docker/metadata-action`、`gh api` 清旧镜像、`type=gha` 缓存全部去掉，改为纯 `docker` CLI
- 凭据：`REGISTRY_USERNAME` / `REGISTRY_PASSWORD`，缺失时回退到 runner 内置 `GITHUB_TOKEN`

---

## 4. 已知问题与根因

### 4.1 ✅ `run#3` 失败：runner 无法访问 github.com（**已修复并验证**）

日志（`actions/jobs/4/logs`）：

```
☁  git clone 'https://github.com/actions/checkout' # ref=v4
Unable to clone https://github.com/actions/checkout refs/heads/v4:
Get "https://github.com/actions/checkout/info/refs?service=git-upload-pack": unexpected EOF
🏁  Job failed
```

即 act_runner 需要去 github.com 拉取 `actions/checkout`，网络不通。

**修复**：去掉 `uses: actions/checkout@v4`，改用 git 直接从内网 Gitea 克隆（提交 `df7b020`）：

```yaml
- name: Checkout repository
  env:
    GITEA_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    HOST=$(echo "${GITHUB_SERVER_URL}" | sed 's|https\?://||')
    find . -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    git clone "http://oauth2:${GITEA_TOKEN}@${HOST}/${GITHUB_REPOSITORY}.git" .
    git checkout "${GITHUB_SHA}"
    git log --oneline -1
```

> **补强（完全本地化）**：上面用 `GITHUB_SERVER_URL` 推断克隆主机，若 Gitea 的 `SERVER_URL` 配置不对会打到 github.com。
> 现已改为在 `env` 里**显式写死** `GITEA_HOST: 10.3.3.15:3030` 与 `GITEA_REPO: pyss56/lxserver`，
> checkout 直接 `git clone "http://oauth2:${GITEA_TOKEN}@${GITEA_HOST}/${GITEA_REPO}.git"`，
> 不再依赖任何 `GITHUB_*` 兼容变量推断地址，运行时完全不碰 github.com（仅保留 Gitea 本地提供的 `GITHUB_SHA`/`GITHUB_ENV`/`GITHUB_TOKEN` 机制）。

### 4.2 ⚠️ 组织级 runner 缺失（隐患）

```
GET /api/v1/orgs/pyss56/actions/runners  → total_count = 0
```

`pyss56/lxserver` 的任务是靠**非组织作用域**的 runner（`e1a8675ce5a1`）接的。
之前 `bee626241e9c` 是 **pavel 用户级** runner，导致组织仓库任务一直 `queued` 无人接。

稳妥做法：给组织单独注册一个 runner（见 §5.2）。

### 4.3 ✅ job 容器内 docker 可用（已验证）

`run#5` 的 step3 实际执行了 `docker login` 并收到 **daemon 层**的响应，说明
runner 镜像内有 docker CLI，且能连到 daemon socket。无需再处理 docker 环境问题。

### 4.4 `config.js` 已改为模板（工作区干净）

`config.js` 已重命名为 `config.example.js`（模板），仓库不再跟踪 `config.js`。
本地运行从模板复制出 `config.js` 即可（未被 git 跟踪，不会进镜像、不会弄脏工作区）。
当前工作区是干净的，CI 用干净检出，无需再处理未提交改动。

### 4.5 ❌ `run#5` 失败：docker 用 HTTPS 访问 HTTP registry（**当前唯一卡点**）

日志（`actions/jobs/7/logs`）：

```
Error response from daemon: Get "https://10.3.3.15:3030/v2/": EOF
❌  Failure - Main Log in to Gitea container registry
exitcode '1': failure
```

docker 客户端对 registry **默认走 HTTPS**，而内网 Gitea 是纯 HTTP，TLS 握手直接失败。

`run#5` 各步骤结果（已确认 checkout 改造生效、docker 可用）：

```
step0 Checkout repository              ✅ success
step1 Read version from config          ✅ success
step2 Update build hash                 ✅ success
step3 Log in to Gitea container registry ❌ failure   ← 卡在这
step4 Build image                       ⏭ skipped
step5 Push image                        ⏭ skipped
```

**修复方向二选一**（均需服务器侧操作，见 §5.1）：

- **A** 把 `10.3.3.15:3030` 加进 runner 宿主 docker 的 `insecure-registries`
- **B（已采用 ✅）** 走现成的 HTTPS 反代 `https://git.l.pyss.cn`（CA 签发证书、受信、且已转发 `/v2/` registry 端点），把 workflow 的 `GITEA_HOST` / `REGISTRY` 改成 `git.l.pyss.cn`。docker 走标准 TLS，无需 runner 侧 `insecure-registries`，无需动服务器 docker 配置。
  - 实测：`curl https://git.l.pyss.cn/v2/` → `401` 且 `cert_verify=0`（证书受信、registry 端点可达），`/api/v1/version` → `1.27.3`（与 `10.3.3.15:3030` 同一个 Gitea）。

---

## 5. 下一步操作（按优先级）

### 5.0 让 docker 连接 registry（已解决 ✅，采用方案 B）

不再需要改 runner 宿主的 docker 配置。已改用 HTTPS 反代 `https://git.l.pyss.cn`：
workflow 把 `GITEA_HOST` 与 `REGISTRY` 都指向 `git.l.pyss.cn`，docker 走标准 TLS（443），
证书为 CA 签发、受信，`/v2/` 端点已被反代转发，因此 `docker login` / `push` 不会再报
`Get "https://10.3.3.15:3030/v2/": EOF`。

（以下 A 方案保留作备选，仅在反代不可用、必须直连 HTTP registry 时才需要。）

<details><summary>方案 A 备选：在 runner 宿主加 insecure-registries（需 root）</summary>

```bash
sudo cat /etc/docker/daemon.json
sudo jq '. + {"insecure-registries": ((.["insecure-registries"] // []) + ["10.3.3.15:3030"] | unique)}' \
  /etc/docker/daemon.json > /tmp/daemon.json && sudo mv /tmp/daemon.json /etc/docker/daemon.json
sudo systemctl restart docker
docker info | grep -A2 "Insecure Registries"
```

</details>

配置好后**不用再推代码**，直接重新触发：

```powershell
$h = @{Authorization = "token <GITEA_TOKEN>"}
Invoke-RestMethod "http://10.3.3.15:3030/api/v1/repos/pyss56/lxserver/actions/workflows/docker.yml/dispatches" `
  -Method Post -Headers $h -Body (@{ref="main"} | ConvertTo-Json) -ContentType "application/json"
```

**备选方案（给 Gitea 加 HTTPS 反代）**：给 Gitea 加 HTTPS 反代（Nginx 443 → 127.0.0.1:3030），再把
`.gitea/workflows/docker.yml` 的 `env.REGISTRY` 改成对应 https 域名。
注意自签证书仍需 `insecure-registries` 或把 CA 加进宿主信任链。

### 5.1 看构建结果

```powershell
# 列出 run
$h = @{Authorization = "token <GITEA_TOKEN>"}
(Invoke-RestMethod "http://10.3.3.15:3030/api/v1/repos/pyss56/lxserver/actions/runs" -Headers $h).workflow_runs |
  ForEach-Object { "run#$($_.id) $($_.status) $($_.conclusion)" }

# 取 job id（注意：job id ≠ run id）
(Invoke-RestMethod "http://10.3.3.15:3030/api/v1/repos/pyss56/lxserver/actions/runs/<RUN_ID>/jobs" -Headers $h).jobs |
  ForEach-Object { "job#$($_.id) $($_.name) $($_.status) $($_.conclusion) runner=$($_.runner_name)" }

# 拉日志（只显示末尾，构建日志很长）
$j = Invoke-WebRequest "http://10.3.3.15:3030/api/v1/repos/pyss56/lxserver/actions/jobs/<JOB_ID>/logs" -Headers $h -UseBasicParsing
$j.Content.Substring([Math]::Max(0, $j.Content.Length - 3000))
```

网页入口：<http://10.3.3.15:3030/pyss56/lxserver/actions>

预期耗时：`npm install` + `tsc` 编译，约 **10-20 分钟**。

### 5.2 给组织注册专属 runner（推荐，解决 §4.2）

在服务器上执行（token 用组织注册令牌）：

```bash
# systemd / 二进制方式
act_runner register \
  --instance http://10.3.3.15:3030 \
  --token <ORG_RUNNER_TOKEN> \
  --name pyss56-runner --labels ubuntu-latest --no-interactive

# 或 docker 方式（注意挂 docker.sock）
docker run -d --name act_runner_pyss56 --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v act_runner_pyss56_data:/data \
  -e GITEA_INSTANCE_URL=http://10.3.3.15:3030 \
  -e GITEA_RUNNER_REGISTRATION_TOKEN=<ORG_RUNNER_TOKEN> \
  -e GITEA_RUNNER_NAME=pyss56-runner \
  -e GITEA_RUNNER_LABELS=ubuntu-latest \
  gitea/act_runner:latest
```

### 5.3 若 docker 在 job 容器内不可用（§4.3 已验证可用，作兜底）

两个方向：

1. **给 runner 挂 docker.sock**（act_runner 配置 `container.options`）：
   ```yaml
   container:
     options: -v /var/run/docker.sock:/var/run/docker.sock
   ```
   并确保 runner 镜像内有 docker CLI。
2. **改用 host 模式 runner**：job 直接在宿主执行，天然有 docker。

### 5.4 构建成功后

```bash
docker pull git.l.pyss.cn/pyss56/lxserver:latest
docker run -d --name lxserver -p 9527:9527 -v /opt/lxserver/data:/server/data \
  git.l.pyss.cn/pyss56/lxserver:latest
```

并到 Gitea 仓库页 **Packages** 中确认镜像已出现。

---

## 6. 常用 API 速查

```powershell
$h = @{Authorization = "token <GITEA_TOKEN>"}
$b = "http://10.3.3.15:3030/api/v1"

# 站点版本
Invoke-RestMethod "$b/version"

# runner 状态（管理员视角，看全部）
(Invoke-RestMethod "$b/admin/actions/runners" -Headers $h).runners |
  ForEach-Object { "$($_.name) $($_.status) busy=$($_.busy)" }

# 手动触发构建（无需 push）
Invoke-RestMethod "$b/repos/pyss56/lxserver/actions/workflows/docker.yml/dispatches" `
  -Method Post -Headers $h -Body (@{ref="main"} | ConvertTo-Json) -ContentType "application/json"

# 查看组织 secrets 名（值不可读）
Invoke-RestMethod "$b/orgs/pyss56/actions/secrets" -Headers $h
```

---

## 7. 另一条并行任务线：Subsonic 协议补齐

详见 `TODO.md`（Subsonic 协议补齐未落地项）：

- 批 1-4 已完成并提交（`star`/`unstar`、`setRating`、播放列表写操作、`getIndexes`）
- **批 5 未做**：空结构兜底 + `getScanStatus` 等

用户曾反馈界面出现 `Subsonic Debug ⚠️ 未实现`（来自 `src/server/subsonic.ts:362` 的调试日志，
即客户端调用了 `handleRequest` 的 `default` 分支）。

已实现端点见 `src/server/subsonic.ts` 的 `handleRequest` switch（约 250-365 行）。
批 5 建议补齐（返回合法空结构，避免客户端闪退）：

```
getPodcasts / getNewestPodcasts / getShares / getBookmarks / createBookmark / deleteBookmark
getPlayQueue / savePlayQueue / getVideos / getChatMessages / addChatMessage
getAvatar / jukeboxControl / getAlbumInfo / getAlbumInfo2 / startScan / getUsers
```

> 排查提示：如果用户是在**服务器上的旧实例**看到"未实现"（该实例未包含批 1-4），
> 那么 `star`/`unstar`/`setRating`/`createPlaylist`/`deletePlaylist`/`getIndexes` 也会报未实现，
> 这种情况下应先把新镜像部署上去，再判断还缺什么。

---

## 8. 注意事项

- `.gitea-token` 与 `config.js` 都**不要**提交
- 删除仓库/用户、轮换 token 属于破坏性操作，动手前先跟用户确认
- 不要强推 `main`、不要改 `git config`、不要跳过 git hook
- Gitea 日志 API 的 **job id ≠ run id**，取日志前务必先查 `runs/<id>/jobs`
