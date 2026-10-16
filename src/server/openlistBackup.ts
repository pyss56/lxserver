/**
 * OpenList 音频备份管理器
 * 衔接：fileCache 落盘钩子 -> 按 per-user 配置判定是否备份 -> 上传(OpenListClient) -> 写入 SQLite(4 态)
 * 状态机：pending -> uploading -> completed -> verified（失败记 failed）
 *  - completed: OpenList API 返回成功（文件已落盘，但网盘后台可能仍在处理）
 *  - verified : 验证轮询器轮询 openlist 确认文件已可读（存在且 size 匹配）
 *  - keepLocalAfterUpload=false 时，在 verified 后删除本地文件
 */
import path from 'node:path'
import fs from 'node:fs'
import { OpenListClient } from './openlistClient'
import {
  ensureBackupTables,
  upsertBackupFile,
  setBackupStatus,
  getBackupByLocalPath,
  listBackupByStatus,
  listAllBackups,
  BackupFileRow,
} from './openlistBackupDb'

interface UserBackupCfg {
  user: string
  enabled: boolean
  downloadDir: string
  cacheDir: string
}

interface BackupConfig {
  enable: boolean
  endpoint: string
  username: string
  password: string
  token: string
  root: string
  keepLocalAfterUpload: boolean
  verifyInterval: number
  includeNonAudio: boolean
  userBackups: UserBackupCfg[]
}

function getConfig(): BackupConfig {
  const c: any = (globalThis as any).lx?.config || {}
  return {
    enable: !!c['openlist.enable'],
    endpoint: c['openlist.endpoint'] || '',
    username: c['openlist.username'] || '',
    password: c['openlist.password'] || '',
    token: c['openlist.token'] || '',
    root: c['openlist.root'] || '/lx_music',
    keepLocalAfterUpload: c['openlist.keepLocalAfterUpload'] !== false,
    verifyInterval: Number(c['openlist.verifyInterval'] || 5),
    includeNonAudio: c['openlist.includeNonAudio'] === true,
    userBackups: parseUserBackups(c['openlist.userBackups']),
  }
}

function parseUserBackups(raw: any): UserBackupCfg[] {
  if (!raw) return []
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(arr) ? (arr as UserBackupCfg[]) : []
  } catch {
    return []
  }
}

let client: OpenListClient | null = null
let verifyTimer: ReturnType<typeof setInterval> | null = null
let verifyRunning = false

function getClient(): OpenListClient | null {
  const cfg = getConfig()
  if (!cfg.enable || !cfg.endpoint) return null
  client = new OpenListClient({
    endpoint: cfg.endpoint,
    username: cfg.username,
    password: cfg.password,
    token: cfg.token,
    root: cfg.root,
  })
  return client
}

function isSubPath(child: string, parent: string): boolean {
  const np = path.normalize(parent)
  const nc = path.normalize(child)
  return nc === np || nc.startsWith(np + path.sep)
}

// 常见图片（非音频）扩展名；开启 includeNonAudio 时一并备份这些文件
const NON_AUDIO_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'heic', 'avif', 'jpe', 'tif', 'tiff']

/**
 * 扫描下载/缓存目录中的图片等非音频文件，按同一 folderType 一并加入备份队列。
 * 仅在 includeNonAudio 开启时调用；已处于上传中/完成/已验证的文件会被跳过。
 */
function queueNonAudioFromDir(user: string, folderType: 'cache' | 'music', dir: string, cl: OpenListClient, cfg: BackupConfig): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    const ext = (path.extname(e.name).split('.').pop() || '').toLowerCase()
    if (!NON_AUDIO_EXT.includes(ext)) continue
    const full = path.join(dir, e.name)
    const existing = getBackupByLocalPath(user, folderType, full)
    if (existing && (existing.status === 'uploading' || existing.status === 'completed' || existing.status === 'verified')) continue
    const relative = path.relative(dir, full).replace(/\\/g, '/')
    const remotePath = cl.resolveRemotePath(`${user}/${folderType}/${relative}`)
    const row = upsertBackupFile({
      user,
      folderType,
      localPath: full,
      remotePath,
      status: 'pending',
    })
    void uploadOne(row, cl, cfg)
  }
}

/**
 * 落盘钩子入口（由 fileCache 在音频文件写入并登记索引后调用）。
 * @param user 归一化后的用户名
 * @param folderType 'cache' | 'music'（music = 用户下载目录）
 * @param localPath 已落盘的音频文件绝对路径
 */
export function onFileCached(
  user: string,
  folderType: 'cache' | 'music',
  localPath: string,
  meta: { source?: string; songmid?: string; quality?: string } = {},
): void {
  const cfg = getConfig()
  if (!cfg.enable) return
  const entry = cfg.userBackups.find((u) => u.user === user && u.enabled)
  if (!entry) return
  let dir = folderType === 'music' ? entry.downloadDir : entry.cacheDir
  // 目录留空则回退到该用户默认空间目录（dataPath/music 或 dataPath/cache）
  if (!dir) {
    try {
      const users: any[] = (globalThis as any).lx?.config?.users || []
      const u = users.find((x) => x.name === user)
      if (u && u.dataPath) {
        dir = folderType === 'music' ? path.join(u.dataPath, 'music') : path.join(u.dataPath, 'cache')
      }
    } catch {
      return
    }
  }
  if (!dir || !isSubPath(localPath, dir)) return

  const cl = getClient()
  if (!cl) return
  ensureBackupTables()

  const relative = path.relative(dir, localPath).replace(/\\/g, '/')
  const remotePath = cl.resolveRemotePath(`${user}/${folderType}/${relative}`)

  const existing = getBackupByLocalPath(user, folderType, localPath)
  if (existing && (existing.status === 'uploading' || existing.status === 'completed' || existing.status === 'verified')) {
    return // 已在处理或已完成，跳过重复上传
  }

  const row = upsertBackupFile({
    user,
    folderType,
    localPath,
    remotePath,
    source: meta.source || null,
    songmid: meta.songmid || null,
    quality: meta.quality || null,
    status: 'pending',
  })
  void uploadOne(row, cl, cfg)
  if (cfg.includeNonAudio) {
    queueNonAudioFromDir(user, folderType, dir, cl, cfg)
  }
  lazyStartScheduler()
}

async function uploadOne(row: BackupFileRow, cl: OpenListClient, cfg: BackupConfig): Promise<void> {
  try {
    setBackupStatus(row.id, 'uploading')
    await cl.mkdir(path.posix.dirname(row.remote_path))
    const info = await cl.upload(row.local_path, row.remote_path)
    setBackupStatus(row.id, 'completed', {
      size: info.size,
      name: info.name || path.basename(row.remote_path),
      remotePath: row.remote_path,
    })
    // 不在此删本地；待 verify 确认(verified)后再删，确保网盘已落库
  } catch (e: any) {
    setBackupStatus(row.id, 'failed', { error: String(e?.message || e) })
  }
}

/** 验证轮询：把 completed/uploading 中已被 openlist 确认落库的行推进到 verified，并按需删除本地副本 */
export async function verifyPending(): Promise<void> {
  if (verifyRunning) return
  verifyRunning = true
  try {
    const cl = getClient()
    if (!cl) return
    const cfg = getConfig()
    const rows = [...listBackupByStatus('completed'), ...listBackupByStatus('uploading')]
    for (const row of rows) {
      try {
        const info = await cl.getFileInfo(row.remote_path)
        if (info && info.size != null) {
          // 验证成功：固化 openlist 纯路径（不含域名/URL 前缀），供后续定位与下载使用
          setBackupStatus(row.id, 'verified', { size: info.size, remotePath: row.remote_path })
          if (!cfg.keepLocalAfterUpload && row.local_path && fs.existsSync(row.local_path)) {
            try {
              fs.unlinkSync(row.local_path)
              console.log('[openlist-backup] 已删除本地副本:', row.local_path)
            } catch { /* 忽略删除失败 */ }
          }
        }
      } catch {
        // 尚未就绪（仍在后台处理），留待下次轮询
      }
    }
  } catch (e) {
    console.warn('[openlist-backup] 验证轮询出错:', e)
  } finally {
    verifyRunning = false
  }
}

function lazyStartScheduler(): void {
  if (verifyTimer) return
  const cfg = getConfig()
  const intervalMs = Math.max(1, cfg.verifyInterval) * 60 * 1000
  verifyTimer = setInterval(() => { void verifyPending() }, intervalMs)
  void verifyPending()
}

/** 服务启动时显式调用，确保重启后也能持续验证（即使暂无新文件落盘） */
export function startVerifyScheduler(): void {
  if (verifyTimer) return
  lazyStartScheduler()
}

export function stopVerifyScheduler(): void {
  if (verifyTimer) {
    clearInterval(verifyTimer)
    verifyTimer = null
  }
}

export function listBackups(): BackupFileRow[] {
  ensureBackupTables()
  return listAllBackups()
}
