# 分支对比与拆分方案：dev / main / mydev

- 生成时间：2026-10-23（拆分方案于同日追加）
- 背景：上游 5 个 PR（#446 Subsonic 独立配置页、#453 OpenList 备份、#454 standalone 开关、#455 发现页修复、#459 下载缓存兜底）**均已关闭且未合并**（state=closed, merged=false）。本次先对比已合并相应工作的 `dev` 与 `main`，并引入 `mydev = upstream/dev` 作为干净基线，再按功能拆成独立分支逐步并入 `mydev`。
- 方法：`git cherry`（patch-id 比对）做提交级差异；`git grep` / `git cat-file` 做功能级标记核对；`git diff --numstat` 复核 dev/main 方向。

## 1. 各分支 HEAD

| 分支 | HEAD | 说明 |
|---|---|---|
| `dev` | `4d66f76` | 合并了 consolidated 的 Subsonic 工作 + 原有 OpenList 旧谱系 |
| `main` | `0b50e96` | 合并了 consolidated 的 Subsonic 工作 + #453/#455 系列 |
| `mydev` | `4d98fbc` | `= upstream/dev`，干净基线，不含任何 PR 内容 |
| `dev-20261023-0849` | `4d66f76` | 本次操作前对 `dev` 的时间戳备份分支 |

## 2. 提交级差异（git cherry，patch-id 比对）

- `dev` 相对 `main` 独有提交：**1 条等价**（`4021a78` 下载缓存 == `main` 的 `5686498`）+ **37 条无等价**（CI、OpenList 旧谱系、subsonic 端口重构、版本号、#446 独立页主体 `c56d517` 等）。
- `main` 相对 `dev` 独有提交：**1 条等价**（同上）+ **13 条无等价**（#453 OpenList 干净谱系 `7133656`、#455 发现页 `4c531ea`、fromCodePoint `52b298b`、buildDownloadMeta `1baa9e9`、fileCache 下载钩子 `139c718`、CI 等）。

> 结论：**二者非提交一致**（SHA 不同，且大量提交在对方分支无等价 patch-id），只是功能上高度重叠。

## 3. 功能矩阵（干净核对结果）

| 功能 | dev | main | mydev/upstream-dev | 来源 PR |
|---|---|---|---|---|
| Subsonic 独立配置页 `view-subsonic` | ✅ | ✅ | ❌ | #446 |
| `subsonic.standalone` 开关（前端读/写 + 服务端持久化 + 三条件启动） | ✅ | ✅ | ❌ | #454（并入 #446） |
| 下载缓存 any-quality 兜底 | ✅ | ✅ | ❌ | #459 |
| 发现页 `decodeEntities` 用 `fromCodePoint` + 码点校验 | ❌ | ✅ | ❌ | #455 |
| OpenList 备份三件套（openlistBackup/Client/Db 文件存在） | ✅ | ✅ | ❌ | #453（两分支谱系不同） |
| OpenList `buildDownloadMeta`（完整媒体元数据） | ❌ | ✅ | ❌ | #453 后续（`1baa9e9`） |
| `openlist.port` 配置项落地 | ❌ | ❌ | ❌ | 历史遗留（两分支均用 `subsonic.port`） |
| `docker-compose.yml` 暴露 `4050` | ✅ | ✅ | ❌ | #454 |
| CI 使用 `GHCR_TOKEN` 登录 GHCR | ✅ | ✅ | ❌ | CI 提交 |
| 版本号 | v2.1.3.1 | v2.1.3.2 | （上游）2.1.3 | — |

## 4. 一致性结论

1. **三个 Subsonic 相关 PR（#446 配置页、#454 standalone、#459 下载缓存）：dev 与 main 一致**——均来自本次 consolidated 合并。
2. **总体方向（已用 numstat 复核）**：`main` 在 **OpenList / 发现页 / server.ts（`validateOpenListConfig` 仅配置变更才联网强校验）** 上领先 `dev`；`dev` 仅在 **CI / Dockerfile / compose（直接暴露 4050）/ 前端细节** 上领先。即 dev 并不是全面领先，OpenList 与发现页修复是 dev 落后于 main。
3. **OpenList（#453）：两者都有，但谱系不一致**——`main` 为较新的干净谱系（含 `buildDownloadMeta`、下载路径 name 统一、CodeRabbit 数据完整性/安全修复）；`dev` 为较早的旧谱系（**缺 `buildDownloadMeta`**）。功能大致重叠，但 `main` 更完整。
4. **发现页（#455）：仅 `main` 包含**（`fromCodePoint` + 码点范围校验）；**`dev` 缺失**，仍是旧 `fromCharCode` 实现。
5. **上游（`mydev` / `upstream/dev`）：全部不含**——5 个 PR 均未合入上游。

## 5. 关键风险提示

- `dev` 缺少 #455 的 `fromCodePoint` 修复 → 发现页的流派/语种列表在遇到 `&#128XXX;` 这类 >BMP 数字实体时仍会乱码或丢字符。
- `dev` 的 OpenList 为旧谱系，若后续在 `dev` 上继续开发，可能与 `main` 的 #453 谱系产生重复实现/合并冲突。
- 两个分支都未把 `openlist.port` 落地（compose/默认配置里实际用的是 `subsonic.port`），与原独立端口设想不一致——属历史遗留，非本次合并引入。

## 6. 建议

- 已统一到 `mydev`（upstream/dev）作为干净基线，按功能拆成独立分支（见第 7 节），逐个并入 `mydev` 并测试后再并下一个。
- OpenList 与 Subsonic 配置页共用 5 个脚手架文件（app.js / index.html / server.ts / defaultConfig.ts / config.d.ts），合并时需注意冲突。
- Subsonic 三件套两分支已一致，可直接基于 `mydev` 重新提交。

## 7. 拆分合并方案（新功能分支，均基于 mydev）

> 所有分支均从 `mydev` 快进创建，彼此独立、无功能依赖。后续由用户逐个并入 `mydev`，完成测试验证后再并下一个。

| 顺序 | 分支名 | 来源 | 文件范围 | 说明 |
|---|---|---|---|---|
| 1 | `feat/subsonic-config-cache-20261023` | `consolidated`（#446 + #454）+ `origin/fix/subsonic-download-cache`（#459） | 8 个 Subsonic 文件 + 测试 | Subsonic 独立配置页 + standalone 开关 + 服务端三条件启动 + 下载缓存任意音质兜底（已含 `subsonic.quality.anyCacheFallback` 门控，见第 8 节） |
| 2 | `feat/discovery-entities-20261023` | `origin/chore/misc-fixes` 的 `discovery.ts`（tip `52b298b`） | `src/server/utils/discovery.ts` | fromCodePoint + 码点校验（#455 实体修复部分） |
| 3 | `feat/ui-typing-fixes-20261023` | 同上分支的 `style.css` + `userApi.ts` | 2 文件 | 侧栏滚动条 + userApi 类型（#455 UI 部分） |
| 4 | `feat/openlist-backup-20261023` | `origin/feat/openlist-backup`（#453） | 14 个 OpenList 文件 | OpenList 备份/同步全套（**最后合并**） |

**合并顺序**：1 → 2 → 3 → 4（第 1 步已合并 Subsonic 配置页与下载缓存为一个分支；OpenList 放最后，且不依赖前述任何功能）。

**注意事项**：
- 4 个分支均直接基于 `mydev`，无互相依赖；OpenList 放第 4 步仅为降低对前序功能的干扰。
- 第 4 步并入 `mydev` 时，因 OpenList 与 Subsonic 配置页共用 `app.js` / `index.html` / `server.ts` / `defaultConfig.ts` / `config.d.ts`，会在这些文件产生冲突，需手动合并（两功能都保留）。
- #455 已拆为「发现页实体」（分支 3）与「UI/类型」（分支 4）两个分支，避免一个 PR 混入不相关改动。

## 8. #459 下载缓存：配置化决策

- **现状问题**：原 `#459` 的任意音质兜底既无 `maxBitrate` 判断，也被用于 `download` 请求，会用超限/低音质缓存顶替客户端要求的音质（卡音质/超上限）。
- **决策**：缓存复用默认**关闭**（避免服务器自担出向流量/代理字节），音质回退改为**确定性规则**（不再用 `cache.fallback` 枚举），严格尊重客户端 `maxBitrate`：精确优先、其余按码率降序（更大码率优先），且绝不超出 `maxBitrate`。
- **方案**：无需配置键。`getCacheProbeOrder` 返回「优先级列表中 ≤ `maxBitrate` 的音质、精确排最前、其余降序」的探测顺序；回源选音质 `getQualityPriorityOrder` 同样以 `maxBitrate` 为严格硬上限。转码由单一总开关 `subsonic.transcode.enabled` 控制（已合并原 `onQualityMiss` 冗余开关）。
- **整体管线（音质与格式共用）**：缓存开启且优先 → 按确定性规则满足音质要求（精确优先、更大优先、不超上限），并尽量满足格式（不符则转码）→ 缓存不满足回源 → 回源仍不满足（音质超上限或格式不符）则考虑转码。
- **硬约束（不可配置）**：
  1. 播放/下载共用同一套缓存探测与回退逻辑（确定性规则：精确优先 + cap 内降序），仅投递层下载加 `Content-Disposition` 附件头区分，不再为 download 单独降级；
  2. 更高音质回退受 `maxBitrate` 硬上限约束，绝不突破客户端声明；
  3. 格式与音质同策略（优先满足要求）：客户端有 `format` 要求时，缓存命中或回源得到文件后，只要容器与要求不符且 `subsonic.transcode.enabled` 开启就转码（缓存命中转本地文件、回源转源 URL）；否则发原始文件（ffmpeg 缺失时不会把本地路径当远程 302 而失效）。
  4. `maxBitrate` 为**严格硬上限**（允许降低码率、绝不超客户端声明）：`>=320` **不再**视作"发原版/不限制"。无损 `flac` 仅在 `maxBitrate=0`（无上限）时进入 higher 回退与源站优选；`maxBitrate>=320` 的请求最高封顶到 `320k`。该语义在三处统一落实：`handleStream` 请求音质推导（5618，仅 `0` 才请求 `flac`）、源站解析 `getQualityPriorityOrder`（5284）、缓存回退 `getCacheProbeOrder`（5977）的 `cap` 均改为 `maxBitrate===0 ? Infinity : maxBitrate`，避免"缓存比源站更保守"的不一致。
  5. `clientCapMode` 配置项已**彻底移除**（连同 `defaultConfig.ts`/`types/config.d.ts`/`server.ts`(GET响应+保存校验+默认)/`index.ts`(env)/前端 UI 的读取、校验与控件全部删除；pavel2 原有，但 soft 突破上限语义不合理故整体删除）：音质优选始终严格 ≤ `maxBitrate`，由 `getQualityPriorityOrder` 直接返回 ≤ maxBitrate 音质，不再有任何突破上限分支。
- **遗漏场景核查（已处理 / 已知限制）**：
  - download 与 playback 逻辑分叉（旧实现 download 强制精确-only、不走格式转码）→ 已统一为同一 `getCacheProbeOrder` 与同一格式转码分支，仅投递层附件头区分。
  - 缓存命中格式转码若 ffmpeg 缺失会 `safeRedirect` 到本地路径而失效 → 仅在 `subsonic.transcode.enabled` 时触发，否则发原始缓存文件。
  - download 此前无任何 `Content-Disposition`（与 stream 一样 inline 投递）→ 现下载在所有返回路径统一加附件头。
  - 已知限制（非阻塞）：① 转码产物不回写缓存（按需实时转码）；② 转码路径不支持 Range/断点续传（200 全量），缓存直读支持 206；③ 缓存探测的"更大码率优先"也永不突破 `maxBitrate`（已无 `higher` 枚举）；④ 客户端 `format` 不在支持列表(mp3/flac/ogg/opus/aac/m4a)时按原始容器下发。
- **下载范围的界定（本设计语境）**：本设计所讨论的「下载」特指**下发到客户端设备**的下载，不含「下载到服务器」：
  - 含：① Subsonic 协议 `download` 端点（`handleStream` 的 `method='download'`，音质/格式由服务端按 `maxBitrate`/`format` 选择，受确定性缓存规则 + 单一转码总开关约束，与 `stream` 共用一套）；② web 浏览器下载到本机（`/api/music/download`，为「已解析 URL」的下载代理，客户端驱动精确音质、带附件头/Range/标签，**不做**服务端音质兜底/格式转码，保持 web 客户端驱动原则）。
  - 不含：web「下载到服务器」的缓存入库路径（`/api/music/cache/download`、`/api/user/sync-download/*`、持久下载队列、自定义音乐下载）—— 这类是把音源拉入服务器 `fileCache` 的**生产者**，正是 Subsonic/web 播放与下载复用缓存的来源，二者互补不冲突。
- **与 web/上游的关系**：`maxBitrate`、`quality.priority`、`playCacheFirst`、`transcode.enabled`、`onQualityMiss` 均为**本仓 pavel2 原有代码**（非外部上游）；其中 `clientCapMode` 配置项已彻底移除（音质优选统一严格 ≤maxBitrate，见硬约束 5），`onQualityMiss` 已合并进 `transcode.enabled`（单一转码总开关），`cache.fallback` 枚举已删除、改为确定性缓存规则。web 播放与浏览器下载到本机走 `server.ts`，是**客户端驱动精确音质 + 共用 `fileCache` 仓库**，无独立音质回退策略，与本分支 Subsonic 策略**不冲突、互补**（web 任意路径落盘的缓存可被 Subsonic 复用）。「download 强制精确-only、不走格式转码」这一音质分歧**并非上游代码**，而是本分支早期迭代中我引入的特例（现已移除、与 playback 统一）。音质优选/兜底逻辑保持 Subsonic 内部，不抽成 web 共用方法（避免 web 端被服务端静默换音质）。
- **配置落点**：`src/defaultConfig.ts` + `src/types/config.d.ts` + `src/server/subsonic.ts`（新增 `getCacheProbeOrder`/`shouldTranscodeFormat`/`getRequestedAudioFormat`）；运行时读取，不进 `restartRequiredKeys`。
- **状态**：已在该分支实现，可直接合并进 `mydev` 测试。
