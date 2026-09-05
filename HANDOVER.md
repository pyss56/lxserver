# lx-server 交接文档 / Handover Notes

> 项目路径：`C:\Users\user_00AVzWFpK\CodeBuddy\20260904162832\lxserver`
> 最后更新：2026-09-05
> 适用读者：需要继续排查 / 完成「播放功能」修复的下一任维护者（或未来的自己）

---

## 0. 一句话结论

这是一个 **lx-music-server 的分支**，对外提供 Subsonic 兼容接口，配合「音流」客户端使用。

- ✅ **搜索 / star / unstar / 播放(WY)** 已修好或已实现。
- ✅ **原生 WY 兜底已上线并验证**：`callUserApiGetMusicUrl` 在所有社区音源失败后自动回退到原生网易云 weapi，WY 歌曲可正常放出（302 → 126.net mp3）。
- ❌ **播放仍不覆盖全平台**：本分支**没有内置 kw/tx/mg/kg 的原生解析**，且配的三个社区音源后端全挂。所以 **kw（如「云宫迅音」）、tx、mg、kg 的歌仍放不了**，只有 **wy 平台的歌**能稳定播放。
- 🚧 **待补全**：原生 kw/tx/mg/kg 实现（见 §4.4）。

---

## 1. 运行环境

| 项 | 值 |
|---|---|
| 操作系统 | Windows 11 (win32) |
| 服务端口 | `9527` |
| 账号 / 密码 | `admin` / `password` |
| 本地代理 | `http://127.0.0.1:64338`（音乐源直连被墙，必须走代理） |
| 启动命令 | 见 §5 |
| 客户端 | 「音流」App，连接本机 `9527` 的 Subsonic 接口 |
| Node 路径（实际在用） | `D:\application\nodejs\node.exe`（系统版；如要用托管版见 §5 注释） |

`config.js` 关键项：
- `proxy.all.enabled: true`
- `proxy.all.address: "http://127.0.0.1:64338"`

---

## 2. 已经做完的事

### 2.1 代理取数层修复（已上线，关键）
- **文件**：`src/modules/utils/request.js`
- **问题**：原 `getRequestAgent()` 用 `tunnel.httpsOverHttp` 生成代理 agent，但本机这个正向代理下 `tunnel` 会在 TLS 握手前断连（`Client network socket disconnected...`）。`curl -x` 能通、`tunnel` 不通 → 说明是 agent 选型问题。
- **修复**：改用 `https-proxy-agent`（`HttpsProxyAgent`）。`needle + HttpsProxyAgent` 实测可连通（返回 400=连接成功）。
- **影响范围**：这是所有 SDK 取数（搜索、歌曲信息、歌词、star 解析）的统一出口，所以修完之后：
  - 搜索恢复正常（`阴天`、`云宫迅音` 均返回结果）。
  - `star` 一首「不在任何列表里」的歌时，`resolveMusicById` 现在能走代理去源站取回 → 成功加入收藏（实测 `wy_1806096263` 与 `kw_22875172` 都 `收藏变更=true`）。
  - 之前的 migu 那类 `Unhandled Rejection` 已消失（star 代码本就「找不到就跳过 + 记日志」，是安全的）。

### 2.2 误报澄清
- 「阴天搜不到」是**修复前**的旧状态，现在已能搜到。请在音流里重新搜确认。
- 你 `config.js` 里 `proxy.all` 一直是开的，所以每次启动日志都有 `Music SDK Proxy: Enabled`——这只帮「播放链接获取」那一侧的自定义音源，**帮不了** star 的取歌（取歌走的是另一层，现在已通过 §2.1 修好）。

### 2.3 顺手改动（无害）
- 把 `data/users/source/admin/states.json` 里之前被禁用的 `独家音源.js` / `野花🌷.js` 重新设为 `"enabled": true`。
- 但这俩本身也报错（见 §3），所以重新启用**并没有**救回播放。

---

## 3. 当前阻塞：播放完全挂死（核心待办）

### 3.1 根因（两层）
1. **架构层**：本分支 `src/modules/utils/musicSdk/api-source.js` 的 `getMusicUrl` **只**路由到自定义 UserApi 音源，没有任何内置 SDK 兜底（上游 LX Music 里各平台的 `musicUrl` 在本分支被删掉了，只剩 `musicInfo` + `lyric`）。
2. **数据层**：当前配的三个自定义音源后端**全部失效**：

| 音源 | 后端 | 现象 | 结论 |
|---|---|---|---|
| 聆澜音源(赞助版)[永久] | `source.shiqianjiang.cn` | 返回 403/400，且是 **HTML 不是 JSON**（"服务端响应缺少有效业务码"） | key 过期/失效，**hasUrl:false** |
| 独家音源 | `88.lxmusic.xn--fiqs8s` | 脚本层直接 "unknow error"，**连后端都没打到**；后端 music-url 接口 404 | 脚本兼容性问题 |
| 野花🌷 | （脚本内置） | "Fail"，**无任何 HTTP 请求** | 脚本兼容性问题 |

`callUserApiGetMusicUrl` 每次请求都现读 `states.json`，所以开关即时生效、不用重启——但三个都坏，开关没用。

### 3.2 已探明的事实（避免重复踩坑）
- 原生 kuwo 接口 `www.kuwo.cn/api/v1/.../getPlayUrl` **代理可达**（200），但返回 `"The request is illegal!"` → 需要各平台 token/签名。所以「原生兜底」= 把各平台签名逻辑重写一遍（正是本分支删掉的部分）。
- `tempmusics.tk` 社区代理已死（403）。
- `https://88.lxmusic.xn--fiqs8s/` 根路径可达（200），但 music-url 接口 404。
- `https-proxy-agent` 修复后，所有原生请求**默认就会走代理**（见 `request.js` 第 261 行）。

---

## 4. 原生 getMusicUrl 兜底（已实现并验证）

### 4.1 已落地代码
- **新增** `src/modules/utils/musicSdk/nativeMusicUrl.js`：原生 `getNativeMusicUrl(source, songInfo, type)`。
  - 已实现 **wy（网易云）**：`weapi` 加密 → `http://music.163.com/weapi/song/enhance/player/url/v1`（走 http:// 即可，网易云该接口 http 可用；本项目的 needle/httpFetch 在走该代理时不能隧穿 HTTPS，但 WY 用 http 不受影响）。实测返回 `http://m*.music.126.net/...mp3` 可播放。
  - kw/tx/mg/kg：文件顶部列了 TODO（理由见 §4.4），当前未实现，调用会抛明确错误走上层失败逻辑。
- **改** `src/server/userApi.ts` 的 `callUserApiGetMusicUrl`：
  - 新增 `tryNativeMusicUrl()` 助手（动态 `import('../modules/utils/musicSdk/nativeMusicUrl')`）。
  - 在两个 throw 点（无可用自定义源 / 全部自定义源失败）之前，**先尝试原生兜底**；成功则直接返回 `{ url, type, sourceName:'原生-<source>', attempts }`，与原 UserApi 返回结构一致，下游无感。
  - 这是真正的取链入口（`resolveServerSong` 直接调它），所以兜底只改这一处即可覆盖 /stream 播放路径。
- ⚠️ 注意：**没有改 `api-source.js`**——因为播放链路根本不经过它（`resolveServerSong` 直接调 `callUserApiGetMusicUrl`）。不要重复在 api-source 里加兜底。

### 4.2 验证结果（2026-09-05）
```bash
# 聆澜失败 -> 原生兜底成功
grep "\[Native\]" live.log   # -> [Native] ✓ wy 原生兜底成功返回链接
# 播放返回 302 重定向到真实音频
curl -D - "$B/stream?id=wy_1806096263..." | grep -i location
# 单个 WY 曲与第二个 WY 曲均 302 -> 126.net mp3，follow 后 audio/mpeg 206
```
已确认：`wy_1806096263`、`wy_5272645` 等多首 WY 歌都能通过原生兜底放出音频。

### 4.3 当前覆盖度（重要，别误以为全平台都修好了）
| 平台 | 原生兜底 | 说明 |
|---|---|---|
| wy 网易云 | ✅ 可用 | http weapi，已验证（含「云宫迅音」「阴天」等的 WY 版本） |
| kw 酷我 | ❌ 暂未实现 | `www.kuwo.cn` 首页已不下发 `kw_token`，`getPlayUrl` 直接 "illegal"，无解 |
| tx QQ | ❌ 暂未实现 | `musicu.fcg` vkey 被风控 `code=104009` 拦截，裸请求无 `purl`，需 sign+登录态 |
| kg 酷狗 | ❌ 暂未实现 | `play/getdata` 即便带合法 `FileHash` 也返回 `err_code:30020`（版权/区域） |
| mg 咪咕 | ❌ 暂未实现 | 官方接口强制 https + 签名 |

> 所以**用户举例的「云宫迅音 kw_22875172」目前仍放不了**（kw 无原生兜底，且三个社区音源全挂）。但**同一首歌的网易云版本可放**：search3 搜「云宫迅音」只返回 `wy_` 系列 id，已验证 `wy_1378930371` 等 WY 版本能 302→126.net 放出音频。建议用户在音流里**选「网易云」音源版本**播放。只有 **wy 平台的歌**能稳定放出。这是当前交付状态的硬限制。

### 4.4 想补全其它平台的下一步

> ⚠️ 先说结论：其余四个平台在当前环境/代理下**暂时都是死路**，原因是各平台自身的鉴权/风控，不是代码没写：
> - **kw 酷我**：`www.kuwo.cn` 首页已不再下发 `kw_token` cookie（实测只有 Hm_Iuvt 分析 cookie），`getPlayUrl` 直接 "illegal"。无有效 token 来源则无解。
> - **tx QQ**：`musicu.fcg` 的 `vkey` 现在被风控 `code=104009(invalidq)` 拦截，裸请求拿不到 `purl`；需带 QQ 的 `sign`+登录态 cookie 才能过风控。即便用原生 `https` 隧穿代理成功，风控仍是第一道墙，难度高。
> - **kg 酷狗**：`play/getdata` 即便带合法 `FileHash` 也返回 `err_code:30020`（版权/区域限制），不稳。
> - **mg 咪咕**：接口强制 https + 签名，同上需要原生 https + sign。
>
> 若仍要攻坚，建议路线：
> 1. 先解决「代理能否隧穿 HTTPS」——实测 `curl -x` 可以，但本项目的 `needle/httpFetch` 不行；补一个用原生 `node:https` + `HttpsProxyAgent` 的 `nativeRequest` 助手（transport 已验证可通，见 `nativeMusicUrl.js` 顶部注释）。
> 2. 再按平台补 sign：tx 移植 QQ web sign；kw 需拿到有效 `kw_token`；mg 移植咪咕 sign。
> 3. 实现完直接在 `nativeMusicUrl.js` 的 `handlers` 里加 `kw: getKwUrl` 等即可，无需再动 `userApi.ts`。

### 4.5 可选增强（提升用户体验）
- **跨源兜底**：当请求的 kw/tx 等非 WY 歌曲原生失败时，按歌名在 WY 搜同曲并改放 WY 版本。能直接救活「云宫迅音」这类"只有 kw 版被搜到"的场景，但需额外 search + 匹配逻辑，复杂度中等。当前未实现。

---

## 5. 启停命令（Windows Git Bash）

```bash
cd "C:/Users/user_00AVzWFpK/CodeBuddy/20260904162832/lxserver"

# 杀掉旧实例
PID=$(netstat -ano 2>/dev/null | grep ":9527" | grep LISTENING | awk '{print $5}' | head -1)
[ -n "$PID" ] && taskkill /PID "$PID" /T /F

# 启动（tsx loader 直接跑 TS 源码，日志写 live.log）
"D:/application/nodejs/node.exe" \
  --require "C:/Users/user_00AVzWFpK/CodeBuddy/20260904162832/lxserver/node_modules/tsx/dist/preflight.cjs" \
  --import "file:///C:/Users/user_00AVzWFpK/CodeBuddy/20260904162832/lxserver/node_modules/tsx/dist/loader.mjs" \
  src/index.ts > live.log 2>&1 &
```
> 注：如需用托管版 Node，把上面的 `node.exe` 换成 `C:\Users\user_00AVzWFpK\.workbuddy\binaries\node\versions\22.22.2-2\node.exe` 即可，其余不变。

---

## 6. 关键文件速查

| 文件 | 作用 |
|---|---|
| `src/modules/utils/request.js` | 全局 HTTP 出口（已打补丁：https-proxy-agent）；所有 SDK 取数走这里 |
| `src/modules/utils/musicSdk/api-source.js` | `getMusicUrl` 路由（**只走 UserApi，无兜底**——要改这里加原生回退） |
| `src/modules/utils/musicSdk/kw/index.js` | kw 入口，`getMusicUrl` 当前仅 delegate 给 UserApi |
| `src/modules/utils/musicSdk/kw/util.js` | `wbdCrypto`（酷我签名器，原生 kw 播放链路的钥匙） |
| `src/modules/utils/musicSdk/wy/utils/crypto.js` | 完整 weapi/linuxapi/eapi（网易云原生播放最稳） |
| `src/modules/utils/musicSdk/kg/util.js` | `signatureParams` + `createHttpFetch`（酷狗签名+重试） |
| `src/modules/utils/musicSdk/tx/quality.js`、`tx/index.js` | QQ音乐（待确认签名） |
| `src/modules/utils/musicSdk/mg/utils/index.js` | 咪咕（待确认） |
| `src/server/userApi.ts` | `callUserApiGetMusicUrl`（自定义音源取链）+ `getLoadedApis` |
| `src/server/server.ts` | `resolveServerSong` / 流媒体端点（约 780 行起） |
| `data/users/source/_open/*.js` | 第三方自定义音源脚本（独家音源 / 野花🌷） |
| `data/users/source/admin/states.json` | 各音源 enable 开关（实时生效） |
| `config.js` | `proxy.all` 配置 |

---

## 7. 之前的踩坑备忘（别再花时间）
- `tunnel` vs `https-proxy-agent`：本机代理只认后者，已修。
- `resolveMusicById`（star 用）和「播放取链」是**两条不同**的取数路径；star 修好 ≠ 播放修好。
- 改 `states.json` 开关对「三个音源全坏」的情况无效，得从代码层加原生兜底。
- 代理 HTTP 环境变量（`HTTPS_PROXY`）即便设了，原 `request.js` 也用 tunnel 包了一层，同样废——统一用 `https-proxy-agent` 即可。

---

## 8. 给用户的交付状态（截至 2026-09-05）
- 搜索 ✅ / star+unstar ✅ 已可用。
- 播放 ⚠️ **仅 wy（网易云）平台的歌可放**：靠原生 weapi 兜底，已验证。
- 播放 ❌ **kw（酷我，如「云宫迅音」）/ tx / mg / kg 仍放不了**：无原生兜底 + 社区音源全挂。
- 下一步：按 §4.4 补全 kw/tx/mg/kg 原生实现（在 `nativeMusicUrl.js` 的 `handlers` 加对应函数即可，无需再动 `userApi.ts`）。
