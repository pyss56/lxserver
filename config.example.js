// LX Music Sync Server 配置模板
//
// 使用方法：
//   1. 复制本文件为 config.js：  cp config.example.js config.js
//   2. 按需修改后启动服务。
//
// 说明：
//   - config.js 已被 .gitignore 忽略，不会进入版本库。
//   - 也可通过环境变量 CONFIG_PATH 指向任意 .js / .json 文件覆盖默认值。
//   - 文件中的键名直接覆盖 src/defaultConfig.ts 的默认值。
//   - users 中的 dataPath 运行时自动按 DATA_PATH 计算（docker 下为 /server/data），无需填写。

module.exports = {
  "serverName": "lxserver",
  "proxy.enabled": false,
  "proxy.header": "x-real-ip",
  "bindIP": "0.0.0.0",
  "port": 9527,
  "user.enablePath": true,
  "user.enableRoot": false,
  "user.enablePublicRestriction": true,
  "user.enablePublicNonAdminLocalMusic": false,
  "user.enablePublicFavorites": false,
  "user.enablePublicNonAdminAccess": false,
  "user.enableLoginCacheRestriction": false,
  "user.enableCacheSizeLimit": false,
  "user.cacheSizeLimit": 2000,
  "maxSnapshotNum": 10,
  "list.addMusicLocationType": "top",
  "disableTelemetry": false,
  "users": [
    {
      "name": "admin",
      "password": "password"
      // dataPath 运行时自动按 DATA_PATH 计算，无需填写
    }
  ],
  "frontend.password": "123456",
  "webdav.enable": false,
  "webdav.url": "",
  "webdav.username": "",
  "webdav.password": "",
  "webdav.syncPath": "/lx-sync",
  "webdav.backupPath": "/lx-sync-backups",
  "sync.interval": 60,
  "sync.backupInterval": 24,
  "player.enableAuth": false,
  "player.password": "123456",
  // 音乐源代理：默认关闭。启用(proxy.all.enabled=true)时必须同时配置 proxy.all.address
  // （或设置 HTTPS_PROXY 环境变量），否则源请求将不走代理，搜索 / star / 封面 / 播放取链会失败。
  "proxy.all.enabled": false,
  "proxy.all.address": "",
  "admin.path": "",
  "player.path": "/music",
  "subsonic.enable": true,
  "subsonic.path": "/rest",
  "subsonic.enableDebug": true,
  "subsonic.onlineSearch": true,
  "subsonic.onlineSearchMode": "fallback",
  "subsonic.onlineSearchSources": "wy,tx,kw,kg,mg",
  "subsonic.lyricTranslation": true,
  "subsonic.autoCacheOnPlay": true,
  "singer.sourcePriority": [
    "tx",
    "wy"
  ],
  "artist.maxFetchPages": 20,

  // ===== 缓存与音乐库存储策略（服务端统一配置）=====
  "cache.namingPattern": "standard",  // 缓存命名规则 standard | simple
  "cache.location": "root",           // 缓存基础存储位置 root(运行目录/music) | data(DATA_PATH)
  "saveCacheToLibrary": true,         // 流缓存直落共享音乐库 /music
  "saveDownloadToLibrary": true,      // 下载直落共享音乐库 /music
  "enableOnlyDownloadMode": false,    // 仅下载模式：下载到库，不写独立缓存目录
  "enableServerLyricCache": true,     // 服务端歌词缓存

  "system.allowUnsafeVM": false
}
