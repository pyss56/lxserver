import fs from 'node:fs'
import path from 'node:path'
import { getUserSpace } from '@/user'
import { File } from '@/constants'
import { syncLog } from '@/utils/log4js'
import { ScheduledTask, TaskExecutionResult } from './types'

// @ts-ignore
import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
const musicSdk = musicSdkRaw as any

export const TASK_ID = 'network_list_autocheck'
export const TASK_NAME = '网络歌单自动同步更新'

/**
 * 运行时内存临时状态：记录哪些用户的哪些歌单有红点（重启后自动清除）
 * Map<username, Set<listId>>
 */
const updatedListMap = new Map<string, Set<string>>()

export const getUpdatedListIds = (username: string): string[] =>
  Array.from(updatedListMap.get(username) ?? [])

export const addUpdatedListId = (username: string, listId: string): void => {
  if (!updatedListMap.has(username)) updatedListMap.set(username, new Set())
  updatedListMap.get(username)!.add(listId)
}

export const removeUpdatedListId = (username: string, listId: string): void => {
  updatedListMap.get(username)?.delete(listId)
}

/**
 * 解析用户配置的时间间隔（如 '1d2h30m'、'6h'、'30m' 或毫秒数）
 */
export const parseIntervalMs = (value: string | number | undefined | null): number | null => {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return value > 0 ? value : null
  const raw = String(value).trim().toLowerCase()
  if (raw === '' || raw === '0' || raw === 'off' || raw === 'none' || raw === 'disable') return null

  const regex = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g
  let match: RegExpExecArray | null
  let totalMs = 0
  let matchCount = 0

  while ((match = regex.exec(raw)) !== null) {
    matchCount++
    const count = parseFloat(match[1])
    const unit = match[2]
    if (!Number.isFinite(count) || count < 0) return null
    switch (unit) {
      case 'ms': totalMs += count; break
      case 's': totalMs += count * 1000; break
      case 'm': totalMs += count * 60 * 1000; break
      case 'h': totalMs += count * 60 * 60 * 1000; break
      case 'd': totalMs += count * 24 * 60 * 60 * 1000; break
    }
  }

  if (matchCount === 0) {
    if (/^\d+(\.\d+)?$/.test(raw)) {
      totalMs = parseFloat(raw) * 60 * 60 * 1000
    } else {
      return null
    }
  }

  return Math.max(totalMs, 30 * 1000) // 最小30秒
}

/**
 * 格式化歌曲信息以匹配标准 LX 格式
 */
const formatSongItem = (song: any, defaultSource: string) => {
  if (!song) return song

  const source = song.source || defaultSource
  // 如果本身已经是具备有效 meta 的新格式 MusicInfo，直接返回规范化对象
  if (song.meta && typeof song.meta === 'object' && song.meta.songId !== undefined) {
    return {
      ...song,
      source,
      id: song.id ? String(song.id) : (song.meta.songId ? `${source}_${song.meta.songId}` : String(song.songmid || '')),
    }
  }

  const songmid = song.songmid ?? song.songId ?? song.id ?? ''
  const meta: Record<string, any> = {
    songId: songmid,
    albumName: song.albumName ?? song.album?.name ?? '',
    picUrl: song.img ?? song.pic ?? song.picUrl ?? '',
    qualitys: song.types ?? [],
    _qualitys: song._types ?? {},
    albumId: song.albumId ?? song.album?.id ?? song.albumMid ?? song.album?.mid ?? '',
  }

  let id = song.id ? String(song.id) : `${source}_${songmid}`

  if (meta._qualitys && meta._qualitys.flac32bit && !meta._qualitys.flac24bit) {
    meta._qualitys.flac24bit = meta._qualitys.flac32bit
    delete meta._qualitys.flac32bit
    if (Array.isArray(meta.qualitys)) {
      meta.qualitys = meta.qualitys.map((quality: any) => {
        if (quality && quality.type === 'flac32bit') return { ...quality, type: 'flac24bit' }
        return quality
      })
    }
  }

  switch (source) {
    case 'kg':
      if (song.hash) {
        meta.hash = song.hash
        id = `${songmid}_${song.hash}`
      }
      break
    case 'tx':
      meta.strMediaMid = song.strMediaMid ?? ''
      meta.albumMid = song.albumMid ?? song.album?.mid ?? ''
      if (song.songId) meta.id = song.songId
      break
    case 'mg':
      meta.copyrightId = song.copyrightId ?? ''
      meta.lrcUrl = song.lrcUrl ?? ''
      meta.mrcUrl = song.mrcUrl ?? ''
      meta.trcUrl = song.trcUrl ?? ''
      break
  }

  return {
    id,
    name: song.name || '',
    singer: song.singer || '',
    source,
    interval: song.interval || '',
    meta,
  }
}


/**
 * 执行网络歌单对比检测
 */
export const checkAllUsersNetworkLists = async (): Promise<{
  checkedUsersCount: number
  totalNetworkLists: number
  updatedListsCount: number
  details: Record<string, { changed: string[]; failed: string[] }>
}> => {
  const allUsernames: string[] = []
  if (Array.isArray(global.lx?.config?.users)) {
    for (const u of global.lx.config.users) {
      if (u && u.name) allUsernames.push(u.name)
    }
  }
  if (!allUsernames.includes('_open')) {
    allUsernames.push('_open')
  }

  let totalNetworkLists = 0
  let updatedListsCount = 0
  const details: Record<string, { changed: string[]; failed: string[] }> = {}

  for (const username of allUsernames) {
    try {
      const userSpace = getUserSpace(username)
      const listData = await userSpace.listManage.getListData()
      if (!listData || !Array.isArray(listData.userList) || listData.userList.length === 0) {
        continue
      }

      const targetLists = listData.userList.filter(l => l && l.sourceListId && l.source)
      if (targetLists.length === 0) continue

      totalNetworkLists += targetLists.length
      const changed: string[] = []
      const failed: string[] = []

      // 从内存临时状态读取已有红点标记（重启后自动清空）

      for (const list of targetLists) {
        try {
          const source = String(list.source || '')
          const sourceListId = String(list.sourceListId || '')
          if (!source || !sourceListId) continue
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`平台 ${source} 不支持歌单抓取`)
          }

          // 拉取远端歌单全部页面
          const remoteResult = await musicSdk[source].songList.getListDetail(sourceListId, 1)
          if (!remoteResult || !Array.isArray(remoteResult.list)) {
            throw new Error('远端歌单数据不完整')
          }
          let remoteList = remoteResult.list.map((item: any) => formatSongItem(item, source))

          // 如果有多页，继续拉取剩余页
          const total: number = remoteResult.total ?? remoteResult.list.length
          const pageSize: number = remoteResult.list.length || 1
          const totalPages = Math.ceil(total / pageSize)
          for (let page = 2; page <= totalPages; page++) {
            try {
              const pageResult = await musicSdk[source].songList.getListDetail(sourceListId, page)
              if (pageResult && Array.isArray(pageResult.list) && pageResult.list.length > 0) {
                remoteList = remoteList.concat(pageResult.list.map((item: any) => formatSongItem(item, source)))
              } else {
                break
              }
            } catch {
              break
            }
          }

          const localList: any[] = Array.isArray(list.list) ? list.list : []

          // 规范化 ID 后排序拼接比较：顺序无关，且保留重复项（不做 Set 去重避免误判）
          const normalizeIds = (list: any[]) =>
            list.map((s: any) => String(s.id || s.songmid || s.meta?.songId || '').trim()).sort().join('|')
          const sameIds = normalizeIds(remoteList) === normalizeIds(localList)

          if (!sameIds) {
            // 发现歌曲列表有变化：直接将远端最新歌曲覆盖更新至用户歌单数据中
            try {
              await userSpace.listManage.listDataManage.listMusicOverwrite(list.id, remoteList)
              // 更新歌单基本信息（如果有新名字或封面）
              if (remoteResult.info) {
                const updatedListInfo: any = { ...list }
                if (remoteResult.info.name) updatedListInfo.name = remoteResult.info.name
                if (remoteResult.info.img || remoteResult.info.pic) updatedListInfo.Album = remoteResult.info.img || remoteResult.info.pic
                await userSpace.listManage.listDataManage.userListsUpdate([updatedListInfo])
              }
              // 创建快照并持久化
              await userSpace.listManage.createSnapshot()
            } catch (err: any) {
              syncLog.warn(`[网络歌单] 写入用户 ${username} 歌单 ${list.name || list.id} 失败: ${err.message}`)
            }

            // 记录红点标记到内存（重启后自动清空）
            addUpdatedListId(username, list.id)
            changed.push(list.name || list.id)
            updatedListsCount++
          }
        } catch (err: any) {
          failed.push(list.name || list.id)
          syncLog.warn(`[网络歌单] 检查用户 ${username} 的网络歌单 [${list.name || list.id}] 失败: ${err.message}`)
        }
      }

      // 更新状态已写入内存 taskStore，无需持久化到文件

      details[username] = { changed, failed }
    } catch (err: any) {
      syncLog.warn(`[网络歌单] 处理用户 ${username} 失败: ${err.message}`)
    }
  }

  return {
    checkedUsersCount: allUsernames.length,
    totalNetworkLists,
    updatedListsCount,
    details
  }
}

/**
 * 从各用户的 settings.json 中读取网络歌单自动更新的配置
 */
export const loadNetworkListTaskConfig = (): { intervalMs: number; enabled: boolean } => {
  let intervalMs = 6 * 60 * 60 * 1000 // 默认 6 小时
  let enabled = true

  const userCandidates: string[] = []
  if (Array.isArray(global.lx?.config?.users)) {
    for (const u of global.lx.config.users) {
      if (u && u.name) userCandidates.push(u.name)
    }
  }
  if (!userCandidates.includes('_open')) {
    userCandidates.push('_open')
  }

  // 遍历所有用户，如果找到用户的设置文件就读取其配置
  for (const username of userCandidates) {
    try {
      const userSpace = getUserSpace(username)
      const settingsPath = path.join(userSpace.dataManage.userDir, File.userSettingsJSON)
      if (fs.existsSync(settingsPath)) {
        const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
        if (saved.networkListAutoCheckInterval) {
          const parsed = parseIntervalMs(saved.networkListAutoCheckInterval)
          if (parsed) intervalMs = parsed
        }
        if (typeof saved.autoUpdateNetworkList === 'boolean') {
          enabled = saved.autoUpdateNetworkList
        }
        // 如果不是默认的 open 用户且已找到配置，以当前真实用户优先
        if (username !== '_open') {
          break
        }
      }
    } catch {}
  }

  return { intervalMs, enabled }
}

/**
 * 创建网络歌单自动检测 Task 实例
 */
export const createNetworkListTask = (): ScheduledTask => {
  const config = loadNetworkListTaskConfig()

  return {
    id: TASK_ID,
    name: TASK_NAME,
    intervalMs: config.intervalMs,
    enabled: config.enabled,
    isRunning: false,
    run: async () => {
      const res = await checkAllUsersNetworkLists()

      // 网络歌单更新完成后，触发同步下载任务（低耦合：按需导入，运行中则跳过）
      try {
        const { syncDownloadForAllUsers } = await import('./syncDownloadTask.js')
        void syncDownloadForAllUsers()
      } catch (e: any) {
        syncLog.warn(`[网络歌单] 触发同步下载失败: ${e.message}`)
      }

      return {
        taskId: TASK_ID,
        timestamp: Date.now(),
        success: true,
        message: `已同步 ${res.checkedUsersCount} 个用户的 ${res.totalNetworkLists} 个网络歌单，其中 ${res.updatedListsCount} 个已自动更新并标红`,
        details: res
      }
    }
  }
}

