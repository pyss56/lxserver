# lxserver · Subsonic 模块：待讨论议题

> 用途：记录尚未实现、待后续讨论 / 扩展的方案。
> 状态：均未落地。

---

## 一、待讨论议题

1. **`onlineSongCache` 落盘**
   - 方向：有界 + TTL（过期惰性刷新）+ 防抖写盘（参考 `subsonic-meta.json` / `listManage`）。
   - 边界：只做元数据缓存，不把搜过的歌当永久曲库。
2. **Alist 网盘同步**
   - 本地优先，`/stream` 热路径只读本地；Alist 做异步冷备份。
   - 接法：写本地 `library/` → rclone / WebDAV 单向同步到 Alist 挂载网盘（解耦）。
3. **`/stream` 302 直链模式（音流客户端）**
   - 音流为原生 App，默认跟随 302、不受 CORS 限制，直链播放可行。
   - 前提：Range 透传、直链每次现签、Content-Type 正确。
   - 方案：`/stream` 可切换 `proxy`（默认）/ `redirect`。
4. **音频文件本地库（收藏即落盘）**
   - 扩展 `fileCache` 或独立 `library/` 目录，收藏/下载即落盘。
5. **migu `getCoverArt` 空 `resourceId` 报错**
   - 现状：`mg/utils/index.js` 因空 `resourceId` 触发 `try max num` 重试；migu 搜索正常。
   - 性质：预存音源 SDK bug，非本阶段引入；方向待定（改 SDK 或做兜底跳过）。
6. **酷我歌词加密未解密**
   - 现状：`getLyrics` 拉到 `newlyric.kuwo.cn` 返回 200，但 body 为加密二进制，可能无明文。
   - 性质：音源 SDK 层加密，需确认是否存在可用解密方案。

---

## 二、验证状态（已知限制）
- ⚠️ migu `getCoverArt` 报错仍存在（源 SDK 问题，非本次引入）。
- ⚠️ 酷我歌词可能无明文（加密未解）。

---

*整理时间：2026-09-05*
