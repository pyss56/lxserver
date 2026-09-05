# lxserver · Subsonic 模块：已实现改动

> 用途：记录本阶段已落地的代码改动与「已实现功能」。
> 范围：`src/server/subsonic.ts`、`src/musicSdk/kg/musicInfo.js`
> 状态：代码已落地，待重启回归验证。

---

## 一、用户视角：本质是 1 个功能

> **「在线歌曲元数据在全场景可用且一致」**
> 用户搜到 / 播过 / 收藏的歌，歌名、歌手、封面、歌词都对，能加收藏、能播。
> 用户不关心背后有多少内部机制——这些只是让上面那句话成立的同一套能力。

### 内部实现机制（技术拆解，非用户功能）
1. **`onlineSongCache` 内存缓存** — `subsonic.ts:42`（定义）、`:44-51`（`cacheOnlineSong`）
   - 类实例上的 `Map<id, MusicInfo>`，FIFO 上限 5000。搜/播/取流时写入，供各入口凭 id 查元数据。
   - 纯内存，重启清空。
2. **`resolveMusicById` 按需回源** — `subsonic.ts:665-725`
   - 缓存与列表都找不到时，按 `<source>_<songId>` 从音源取回并归一化；缺歌名则放弃，避免脏数据。
3. **播放即缓存（取流即写）** — `subsonic.ts:2531-2542`
   - `/stream` 取流时把歌曲元数据写入缓存，使后续 star（仅带 id）能直接命中。
4. **统一解析原语 `resolveSongMeta`** — `subsonic.ts:727-744`（本次重构新增）
   - 把上述「`findMusicById` → `resolveMusicById` → `cacheOnlineSong`」三段式收敛为**一个入口**。
   - `getSong` / `getCoverArt` / `getLyrics` / `star` 全部改调它，行为一致、不再各自重复。

### 统一前的散落点（重构已消除）
| 入口 | 原写法 | 现状 |
|------|--------|------|
| `getSong` | 各自 find→resolve→cache | ✅ 改调 `resolveSongMeta` |
| `star` | 各自 find→resolve→cache + 专属 debug | ✅ 改调 `resolveSongMeta`，保留「从源取回」标记 |
| `getCoverArt` | `findMusicById` + 专辑库兜底 | ✅ 改调 `resolveSongMeta`（仍保留专辑/歌手路由） |
| `getLyrics` | 仅 `findMusicById` | ✅ 改调 `resolveSongMeta`（顺带获得回源能力，KG/MG 歌词更准） |
| `stream` 播放即缓存 | 直接 `cacheOnlineSong(musicInfo)` | ⚠️ 保留：它缓存的是「正在播放的歌曲对象」，与解析原语互补，非三段式重复 |

---

## 二、背景：项目里「音乐库」由三层组成
- **用户列表（真实曲库，已落盘）**：love / default / 收藏 等通过 `listManage` 写成磁盘 JSON，重启仍在。
- **文件缓存 `fileCache`（真实音频，已落盘）**：`cache/`、`music/` 下存下载的 `.flac/.mp3`，由 `cache_index.json` 索引起重/去重。
- **`onlineSongCache`（临时元数据，内存）**：仅搜过/播过的歌的元数据 Map，重启清空，非曲库。
> 本阶段讨论的「落盘 / 同步 / 收藏落盘」，都是在 `用户列表 + fileCache` 之上做扩展，不把 `onlineSongCache` 当永久库。

---

## 三、验证状态（已确认）
- ✅ star（kg / wy）成功，日志确认。
- ✅ `resolveSongMeta` 重构落地，五入口行为统一，无 lint 错误（**待重启后回归验证**）。

---

## 四、Subsonic 协议端点对齐（补齐进度）

> Subsonic 协议端点对齐「已实现」部分如下；待办部分见 `TODO.md`。

### 当前已实现端点（对照音流对接文档）

| 端点 | 状态 | 备注 |
| --- | --- | --- |
| `ping` / `getLicense` | `[x]` | |
| `getMusicFolders` / `getMusicDirectory` | `[x]` | |
| `getGenres` / `getSongsByGenre(2)` | `[x]` | |
| `getArtists` / `getArtistList` / `getArtist` | `[x]` | 音乐库歌手维度 |
| `getAlbum` / `getAlbumList(2)` / `getSong` | `[x]` | `getSong` 走 `resolveSongMeta` 统一解析 |
| `getSimilarSongs(2)` / `getTopSongs` / `getRandomSongs` | `[x]` | |
| `getArtistInfo(2)` / `getLyrics` / `getLyricsBySongId` | `[x]` | `getLyrics` 走 `resolveSongMeta`，新增回源能力 |
| `getStarred(2)` | `[x]` | 仅返回 love 列表 / 星标条目 |
| `getPlaylists` / `getPlaylist` | `[x]` | love / default / userList 映射 |
| `updatePlaylist` | `[x]` | `name` / `songIdToAdd` / 多 `songIndexToRemove` |
| `stream` / `download` / `getCoverArt` | `[x]` | `getCoverArt` 走 `resolveSongMeta`；`stream` 播放即缓存落盘 |
| `search` / `search2` / `search3` | `[x]` | |
| `getUser` / `getInternetRadioStations` / `getOpenSubsonicExtensions` | `[x]` | |
| `scrobble` / `getNowPlaying` / `getScanStatus` | `[~]` | 空实现占位，见 `TODO.md` 批 5 |

### 补齐批次落地情况

- **批 1 `star` / `unstar`**：已落地。歌曲收藏进 `loveList`；专辑/歌手星标写每用户 `subsonic-meta.json`（或 `subsonic-starred.json`）。`star` 歌曲定位现复用统一解析原语 `resolveSongMeta`（原 `findMusicById`）。
- **批 2 `setRating`**：已落地。每用户持久化 0-5 评分（0 视为清除）。
- **批 3 播放列表写操作**：已落地。`createPlaylist` / `deletePlaylist` 补齐，`updatePlaylist` 支持 `songIdToAdd` / `name` / `comment` / `public`。
- **批 4 `getIndexes`**：已落地。复用 `getArtists` 聚合输出根级索引，兼容老客户端与音流首页导航。

---

*整理时间：2026-09-05*
