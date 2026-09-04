# Subsonic 协议补齐计划（音流对齐优先）

> 目的：让 lxserver 的 Subsonic/OpenSubsonic 实现与主流客户端（**音流 / StreamMusic**、Feishin、Symfonium 等）对齐。
> 对齐依据：音流（gitbobobo/StreamMusic）官方对接文档 `docs/notes/services/subsonic.md` 中列出的端点清单，叠加 Subsonic 官方 API。
> 实现文件：`src/server/subsonic.ts`（请求分发在 `handleRequest`，端点实现放在 `// 端点实现` 区块）。
> 状态图例：`[ ]` 待办　`[~]` 进行中　`[x]` 完成

## 当前已实现（对照音流对接文档）

| 端点 | 状态 | 备注 |
| --- | --- | --- |
| `ping` / `getLicense` | `[x]` | |
| `getMusicFolders` / `getMusicDirectory` | `[x]` | |
| `getGenres` / `getSongsByGenre(2)` | `[x]` | |
| `getArtists` / `getArtistList` / `getArtist` | `[x]` | 音乐库歌手维度 |
| `getAlbum` / `getAlbumList(2)` / `getSong` | `[x]` | |
| `getSimilarSongs(2)` / `getTopSongs` / `getRandomSongs` | `[x]` | |
| `getArtistInfo(2)` / `getLyrics` / `getLyricsBySongId` | `[x]` | |
| `getStarred(2)` | `[x]` | 批 1 已修正：仅返回 love 列表 / 星标条目 |
| `getPlaylists` / `getPlaylist` | `[x]` | love / default / userList 映射 |
| `updatePlaylist` | `[x]` | 批 3：增补 `name` / `songIdToAdd` / 多 `songIndexToRemove` |
| `stream` / `download` / `getCoverArt` | `[x]` | |
| `scrobble` / `getNowPlaying` / `getScanStatus` | `[~]` | 空实现占位，见批 5 |
| `search` / `search2` / `search3` | `[x]` | |
| `getUser` / `getInternetRadioStations` / `getOpenSubsonicExtensions` | `[x]` | |

## 音流明确使用、但本项目缺失的端点（优先对齐项）

| 端点 | 说明 | 计划批 |
| --- | --- | --- |
| `star` / `unstar` | 收藏歌曲 / 专辑 / 歌手（`id`、`albumId`、`artistId`，支持逗号多值） | 批 1 |
| `setRating` | 0-5 评分，需每用户持久化 | 批 2 |
| `createPlaylist` | 新建歌单或改名（`playlistId` 存在时为更新） | 批 3 |
| `deletePlaylist` | 删除歌单 | 批 3 |
| `getIndexes` | 根级歌手索引（老客户端首屏导航） | 批 4 |

---

## 批 1：`star` / `unstar` 收藏　`[x] 已落地`

目标：客户端「红心/星标」操作落到真实数据；`getStarred(2)` 语义修正为只返回收藏内容。

设计（基于现有数据模型）：
- **歌曲收藏**：`star` 把目标歌曲加入 `loveList`（LX「我的收藏」），已存在则跳过；`unstar` 从 `loveList` 移除。复用 `ListDataManage.listMusicAdd` / `listMusicRemove`，完成后 `createSnapshot()` 持久化。
  - 歌曲定位复用 `findMusicById(username, id)`。
- **专辑 / 歌手收藏**：lxserver 库数据（`library/albums.json`、`library/artists.json`）当前无星标字段。为不动用库 schema，新增每用户星标文件（如 `user/<name>/subsonic-starred.json`）记录 `{ albums: string[], artists: string[] }`，存储 `alb_*` / `art_*` 的 ID。
- **`getStarred(2)` 修正**：song 源从「全部列表歌曲合集」收敛为 `loveList`；album/artist 源从「整库」收敛为星标文件中的条目。
  - 需要保留一个“未收藏时返回空”的语义（对齐协议）；现有用户迁移问题在实现时确认（若影响面大可先做兼容配置）。
- 多值解析：`id` / `albumId` / `artistId` 各自可重复出现且以 `,` 分隔。

验收：
- 音流里点歌曲红心 → `getPlaylists` 中 love 列表 songCount +1；取消红心 → -1。
- 专辑/歌手星标后，`getStarred2` 能返回对应条目。
- 所有写操作后调用快照持久化；非法/不存在 id 不报错。

## 批 2：`setRating` 评分　`[x] 已落地`

目标：评分成功落盘（歌曲/专辑/歌手），支持后续查询展示。

- 新增每用户评分文件（与批 1 星标文件同位置，或合并为 `subsonic-meta.json`）：`{ songs: {id: rating}, albums: {...}, artists: {...} }`。
- `setRating(id, rating)`：rating ∈ [0,5]，0 视为清除；非法值返回错误码 `0`。
- 若子项无存储方案，至少返回 `ok`（音流仅需不报错），但尽量持久化。
- （可选）`musicToSongFlat` 输出不额外加 rating 属性（协议无该字段）。

验收：调用 `setRating` 后返回 `ok`；重启服务后数据仍在。

## 批 3：播放列表写操作补全　`[x] 已落地`

现状：`handleUpdatePlaylist` 只处理 `songIndexToRemove`，`createPlaylist` / `deletePlaylist` 缺失，`updatePlaylist` 的 `songIdToAdd` / `name` / `comment` / `public` 未处理。

目标：
- `createPlaylist`：
  - 无 `playlistId` → `userListCreate(name)` 新建（无歌），或复用 `userListCreate` + `listMusicAdd` 添加首批 `songId`。
  - 有 `playlistId` + `name` → 改歌单名（`updateList` / `userListsUpdate`）。
  - 返回格式：`<1.14.0` 空响应即可；尽量返回创建后的 playlist（含 `id`，音流需拿新 id 继续操作）。
- `deletePlaylist(id)`：删除 userList（`love` / `default` 不可删，返回错误码 50 或 0 提示）。
- `updatePlaylist` 补：`songIdToAdd`（多值，转 `listMusicAdd`）、`name`、`comment`、`public`。
  - 注意现有 `songIndexToRemove` 实现把参数当「索引」处理，而官方语义是「歌单内歌曲序号（从 0 起）」——保留并修正边界。

验收：音流中新建/重命名/删除歌单、增删歌曲均与 `getPlaylists` / `getPlaylist` 保持一致。

## 批 4：`getIndexes` 根级索引　`[x] 已落地`

目标：兼容老客户端（DSub、Ultrasonic 等）与音流首页「音乐库 → 根」的导航。

- 复用 `handleGetArtists` 的歌手聚合逻辑，输出 `<indexes>`：
  - `index name="A-Z / #"` → `artist`（id 与 `getArtists` 保持一致：`art_<source>_<id>`）。
  - 顶层 `<child>`：`love` / `default` / 各 userList（可配置是否包含，与 `getMusicDirectory` 的根视图一致）。
- 支持参数 `musicFolderId`（忽略或按固定 folder 处理）、`ifModifiedSince`（直接返回全量）。
- 根 `id` 语义与 `getMusicDirectory` 的 `root` 保持一致。

验收：客户端从根进入能列歌手与默认列表；点击歌手进入 `getArtist`，点击列表进入 `getPlaylist`。

## 批 5：扩展与兜底（可后续按需）

- `getScanStatus`：改为读取真实扫描状态（如返回静态 `scanning=false,count=0`，至少别报错）；`startScan` 可返回错误码 0 明确不支持。
- 空结构兜底：对无实体功能的端点返回合法空结果而非 `Method not found`，避免客户端闪退：
  `getPodcasts`、`getNewestPodcasts`、`getShares`、`getBookmarks`、`getPlayQueue`、`getVideos`、`getChatMessages`、`getAvatar`、`jukeboxControl` 等。
- 常用增强（对 Feishin / Symfonium 也有价值）：
  `getAlbumInfo(2)`、`savePlayQueue` / `getPlayQueue`（可暂存每用户播放队列）、`createBookmark` / `deleteBookmark`。

---

## 备注 / 设计决策

- 所有「收藏 / 评分 / 播放队列」类状态均按用户隔离，存放在用户数据目录，避免污染 `library` 库公共数据。
- 歌曲在 loveList / userList 中存的是完整 `MusicInfo`，移除/添加用 `findMusicById` 保证拿到的对象可被客户端消费（`stream`、`getCoverArt` 依赖其 `id`）。
- 响应格式需同时兼容 `f=xml` 与 `f=json`（参考现有 `sendResponse` / `sendError` 用法）。
- 分批落地，每批一个 commit，标题示例：`feat(subsonic): implement star/unstar to align with StreamMusic`。
