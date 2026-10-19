/**
 * OpenList 音频备份 / 同步管理器
 * 衔接：fileCache 落盘钩子 -> 按 per-user 配置判定是否上传 -> 上传(OpenListClient) -> 写入 SQLite。
 *
 * 四种同步模式（按「用户 + 目录」条目独立设置，字段 userBackups[].mode）：
 *  - upload-delete : 上传完成 verified 后删除本地副本，并注销缓存索引（避免应用误判本地仍在）
 *  - upload        : 仅上传，保留本地副本
 *  - sync          : 双向同步（本地新增->上传；远端新增->下载并补缓存；任一侧删除->另一侧级联；同名冲突较新者优先）
 *  - download      : 仅从 OpenList 拉取到本地并补缓存（本地为主，远端有更新时覆盖）
 *
 * 状态机：pending -> uploading -> completed -> verified（失败记 failed，删除记 deleted）。
 * 纯路径（不含域名/URL）存库，供后续定位与下载使用。
 */
import path from 'node:path'
import fs from 'node:fs'
import { OpenListClient } from './openlistClient'
import { registerOpenListCacheFile, unregisterOpenListCacheFile } from './fileCache'
import {
  ensureBackupTables,
  upsertBackupFile,
  setBackupStatus,
  getBackupByLocalPath,
  listBackupByStatus,
  listAllBackups,
  listBackupsByUserFolder,
  listAttachments,
  deleteAttachmentsForParent,
  getAttachmentByLocalPath,
  upsertAttachment,
  setAttachmentStatus,
  countRefsToLocalPath,
  listAttachmentsToVerify,
} from './openlistBackupDb'

type SyncMode = 'upload-delete' | 'upload' | 'sync' | 'download'

interface UserBackupCfg {
  user: string
  enabled: boolean
  downloadDir: string
  cacheDir: string
  mode?: SyncMode
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
  syncInterval: number
  userBackups: UserBackupCfg[]
}

const AUDIO_EXT = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'wav', 'ape', 'opus', 'wma', 'alac', 'dsf', 'dff', 'tta', 'wv']
const NON_AUDIO_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'heic', 'avif', 'jpe', 'tif', 'tiff', 'lrc', 'txt']

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
    syncInterval: Number(c['openlist.syncInterval'] || 60),
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

/** 解析条目的有效模式：显式 mode 优先；否则沿用全局 keepLocalAfterUpload 的语义 */
function effectiveMode(entry: UserBackupCfg, cfg: BackupConfig): SyncMode {
  if (entry.mode) return entry.mode
  return cfg.keepLocalAfterUpload === false ? 'upload-delete' : 'upload'
}

/** 从已有备份行推断其模式（用于验证/删除环节） */
function effectiveModeFromRow(row: any, cfg: BackupConfig): SyncMode {
  if (row.mode) return row.mode as SyncMode
  return cfg.keepLocalAfterUpload === false ? 'upload-delete' : 'upload'
}

function normalizeUser(u?: string): string {
  return (u && u !== '_open' && u !== 'default') ? u : '_open'
}

function isAudio(name: string): boolean {
  const ext = (path.extname(name).split('.').pop() || '').toLowerCase()
  return AUDIO_EXT.includes(ext)
}

function categoryOf(ext: string): 'image' | 'lyric' | 'other' {
  const e = ext.toLowerCase()
  if (['lrc', 'txt'].includes(e)) return 'lyric'
  if (NON_AUDIO_EXT.includes(e)) return 'image'
  return 'other'
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

function resolveUserDir(entry: UserBackupCfg, folderType: 'cache' | 'music', cfg: BackupConfig): string | null {
  const raw = folderType === 'music' ? entry.downloadDir : entry.cacheDir
  if (raw && fs.existsSync(raw)) return raw
  try {
    const users: any[] = (globalThis as any).lx?.config?.users || []
    const u = users.find((x) => x.name === entry.user)
    if (u && u.dataPath) {
      return folderType === 'music' ? path.join(u.dataPath, 'music') : path.join(u.dataPath, 'cache')
    }
  } catch { /* ignore */ }
  return raw || null
}

function isSubPath(child: string, parent: string): boolean {
  const np = path.normalize(parent)
  const nc = path.normalize(child)
  return nc === np || nc.startsWith(np + path.sep)
}

// ---------- 缓存索引联动 ----------

/** 删除本地文件时注销缓存条目，避免应用误判本地文件仍存在 */
function removeLocalCache(row: { user: string; folder_type: string; songmid: string | null; quality: string | null }): void {
  const uid = normalizeUser(row.user)
  if (row.songmid) {
    unregisterOpenListCacheFile(uid, row.songmid, row.folder_type as 'cache' | 'music', row.quality || undefined)
  }
}

/**
 * 下载/同步把远端文件落到本地后，登记为缓存条目，使应用能当作缓存文件使用。
 * 以「文件名(去扩展名)」作为缓存 id（v1 最佳努力；若远端文件名遵循命名约定则可被正确匹配）。
 * 返回用于回填备份行的 songmid。
 */
function registerDownloadedCache(user: string, folderType: 'cache' | 'music', localPath: string): string {
  const base = path.basename(localPath)
  const ext = path.extname(base)
  const id = base.slice(0, Math.max(0, base.length - ext.length))
  let size = 0
  let mtime = Date.now()
  try {
    const st = fs.statSync(localPath)
    size = st.size
    mtime = st.mtimeMs
  } catch { /* ignore */ }
  registerOpenListCacheFile(normalizeUser(user), {
    id,
    songmid: id,
    name: id,
    singer: '',
    album: '',
    albumId: '',
    img: '',
    interval: 0,
    source: '',
    requestedSource: '',
    downloadSource: '',
    sourceName: '',
    quality: 'unknown',
    filename: base,
    folder: folderType,
    mtime,
    size,
    ext: ext.replace('.', ''),
    hasCover: false,
    hasLyric: false,
    audioContainer: '',
    bitrate: 0,
    sampleRate: 0,
    bitDepth: 0,
    nativeIds: undefined,
  }, folderType)
  return id
}

// ---------- 上传（含附件）----------

async function uploadOne(row: any, cl: OpenListClient, mode: SyncMode): Promise<void> {
  try {
    setBackupStatus(row.id, 'uploading')
    await cl.mkdir(path.posix.dirname(row.remote_path))
    const info = await cl.upload(row.local_path, row.remote_path)
    setBackupStatus(row.id, 'completed', {
      size: info.size,
      name: info.name || path.basename(row.remote_path),
      remotePath: row.remote_path,
    })
  } catch (e: any) {
    setBackupStatus(row.id, 'failed', { error: String(e?.message || e) })
  }
}

async function uploadAttachment(att: any, cl: OpenListClient): Promise<void> {
  try {
    setAttachmentStatus(att.id, 'uploading')
    if (att.local_path && fs.existsSync(att.local_path)) {
      await cl.mkdir(path.posix.dirname(att.remote_path))
      const info = await cl.upload(att.local_path, att.remote_path)
      setAttachmentStatus(att.id, 'completed', { size: info.size })
    }
    const v = await cl.getFileInfo(att.remote_path)
    if (v && v.size != null) setAttachmentStatus(att.id, 'verified', { size: v.size })
  } catch (e: any) {
    setAttachmentStatus(att.id, 'failed', { error: String(e?.message || e) })
  }
}

/** 上传音频时，扫描其所在目录的图片/歌词等非音频文件，作为该媒体文件的附件一并上传 */
function queueAttachmentsForFile(
  user: string,
  folderType: 'cache' | 'music',
  audioLocalPath: string,
  parentRow: any,
  dir: string,
  cl: OpenListClient,
  cfg: BackupConfig,
): void {
  if (!cfg.includeNonAudio) return
  const audioDir = path.dirname(audioLocalPath)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(audioDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    const ext = (path.extname(e.name).split('.').pop() || '').toLowerCase()
    if (!NON_AUDIO_EXT.includes(ext)) continue
    if (e.name === path.basename(audioLocalPath)) continue
    const full = path.join(audioDir, e.name)
    const rel = path.relative(dir, full).replace(/\\/g, '/')
    const remotePath = cl.resolveRemotePath(`${user}/${folderType}/${rel}`)
    const existing = getAttachmentByLocalPath(user, folderType, full)
    if (existing && ['uploading', 'completed', 'verified'].includes(existing.status)) continue
    const att = upsertAttachment({
      backupFileId: parentRow.id,
      user,
      folderType,
      localPath: full,
      remotePath,
      category: categoryOf(ext),
    })
    void uploadAttachment(att, cl)
  }
}

// ---------- 落盘钩子（事件驱动上传）----------

/**
 * 由 fileCache 在音频文件写入并登记索引后调用。
 * 仅对包含「本地->远端」上传语义的模式（upload-delete/upload/sync）生效；download 模式不回推本地文件。
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
  const dir = resolveUserDir(entry, folderType, cfg)
  if (!dir || !isSubPath(localPath, dir)) return

  const mode = effectiveMode(entry, cfg)
  if (mode === 'download') return

  const cl = getClient()
  if (!cl) return
  ensureBackupTables()

  const relative = path.relative(dir, localPath).replace(/\\/g, '/')
  const remotePath = cl.resolveRemotePath(`${user}/${folderType}/${relative}`)

  const existing = getBackupByLocalPath(user, folderType, localPath)
  if (existing && ['uploading', 'completed', 'verified'].includes(existing.status)) {
    return
  }

  const row = upsertBackupFile({
    user,
    folderType,
    localPath,
    remotePath,
    source: meta.source || null,
    songmid: meta.songmid || null,
    quality: meta.quality || null,
    mode,
    status: 'pending',
  })
  void uploadOne(row, cl, mode)
  if (cfg.includeNonAudio) {
    queueAttachmentsForFile(user, folderType, localPath, row, dir, cl, cfg)
  }
  lazyStartScheduler()
}

// ---------- 验证轮询（确认网盘已落库，并按模式决定删本地/补缓存）----------

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
          setBackupStatus(row.id, 'verified', { size: info.size, remotePath: row.remote_path })
          const mode = effectiveModeFromRow(row, cfg)
          if (mode === 'upload-delete' && row.local_path && fs.existsSync(row.local_path)) {
            try {
              fs.unlinkSync(row.local_path)
              removeLocalCache(row)
              // 级联删除本地附件：仅当该附件自身已 verified 且未被其它备份引用时（避免附件仍在上传中被误删）
              for (const a of listAttachments(row.id)) {
                if (a.status === 'verified' && a.local_path && fs.existsSync(a.local_path) && countRefsToLocalPath(a.local_path, row.id) === 0) {
                  try { fs.unlinkSync(a.local_path) } catch { /* ignore */ }
                }
              }
            } catch { /* ignore */ }
          }
        }
      } catch {
        // 仍在后台处理，留待下次轮询
      }
    }
    // 附件二次校验
    for (const att of listAttachmentsToVerify()) {
      try {
        const info = await cl.getFileInfo(att.remote_path)
        if (info && info.size != null) setAttachmentStatus(att.id, 'verified', { size: info.size })
      } catch { /* ignore */ }
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

// ---------- 手动同步引擎（download / sync / upload 全量）----------

function walkLocal(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkLocal(p, out)
    else if (isAudio(e.name)) out.push(p)
  }
  return out
}

function walkLocalAll(dir: string, map: Map<string, string> = new Map()): Map<string, string> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return map
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkLocalAll(p, map)
    else map.set(path.relative(dir, p).replace(/\\/g, '/'), p)
  }
  return map
}

async function downloadDirection(
  entry: UserBackupCfg,
  cl: OpenListClient,
  cfg: BackupConfig,
  folderType: 'cache' | 'music',
  summary: SyncSummary,
): Promise<void> {
  const dir = resolveUserDir(entry, folderType, cfg)
  if (!dir) return
  const remoteBase = cl.resolveRemotePath(`${entry.user}/${folderType}`)
  let remoteFiles: any[] = []
  try {
    remoteFiles = await cl.listFilesRecursive(remoteBase)
  } catch {
    return
  }
  const remoteMap = new Map<string, any>()
  for (const f of remoteFiles) {
    if (f.isDir) continue
    const rel = f.path.startsWith(remoteBase + '/') ? f.path.slice(remoteBase.length + 1) : f.path.replace(remoteBase, '')
    remoteMap.set(rel, f)
  }
  const localMap = walkLocalAll(dir)
  const mode = effectiveMode(entry, cfg)
  for (const [rel, rf] of remoteMap) {
    const localTarget = path.join(dir, rel)
    const isAud = isAudio(rel)
    if (localMap.has(rel)) {
      if (mode === 'sync') {
        const lm = fs.statSync(localMap.get(rel)!).mtimeMs
        const rm = Date.parse(rf.modified) || 0
        if (rm > lm) {
          fs.mkdirSync(path.dirname(localTarget), { recursive: true })
          await cl.download(rf.path, localTarget)
          if (isAud) {
            const id = registerDownloadedCache(entry.user, folderType, localTarget)
            upsertBackupFile({
              user: entry.user, folderType, localPath: localTarget, remotePath: rf.path,
              songmid: id, mode, status: 'verified', size: rf.size,
            })
          }
        }
      }
      continue
    }
    fs.mkdirSync(path.dirname(localTarget), { recursive: true })
    await cl.download(rf.path, localTarget)
    if (isAud) {
      const id = registerDownloadedCache(entry.user, folderType, localTarget)
      upsertBackupFile({
        user: entry.user, folderType, localPath: localTarget, remotePath: rf.path,
        songmid: id, mode, status: 'verified', size: rf.size,
      })
      summary.downloaded++
    }
  }
}

async function uploadDirection(
  entry: UserBackupCfg,
  cl: OpenListClient,
  cfg: BackupConfig,
  folderType: 'cache' | 'music',
  summary: SyncSummary,
): Promise<void> {
  const dir = resolveUserDir(entry, folderType, cfg)
  if (!dir) return
  const audios = walkLocal(dir)
  const mode = effectiveMode(entry, cfg)
  for (const lp of audios) {
    const rel = path.relative(dir, lp).replace(/\\/g, '/')
    const remotePath = cl.resolveRemotePath(`${entry.user}/${folderType}/${rel}`)
    const existing = getBackupByLocalPath(entry.user, folderType, lp)
    if (existing && ['uploading', 'completed', 'verified'].includes(existing.status)) continue
    const row = upsertBackupFile({
      user: entry.user, folderType, localPath: lp, remotePath, mode, status: 'pending',
    })
    void uploadOne(row, cl, mode)
    summary.uploaded++
    if (cfg.includeNonAudio) {
      queueAttachmentsForFile(entry.user, folderType, lp, row, dir, cl, cfg)
    }
  }
}

async function deletionDetection(
  entry: UserBackupCfg,
  cl: OpenListClient,
  cfg: BackupConfig,
  folderType: 'cache' | 'music',
  summary: SyncSummary,
): Promise<void> {
  const rows = listBackupsByUserFolder(entry.user, folderType)
  for (const row of rows) {
    if (row.status !== 'verified' && row.status !== 'completed') continue
    const localExists = !!row.local_path && fs.existsSync(row.local_path)
    let remoteExists = false
    try {
      const info = await cl.getFileInfo(row.remote_path)
      remoteExists = !!(info && info.size != null)
    } catch {
      remoteExists = false
    }
    if (!localExists && remoteExists) {
      // 本地已删 -> 删远端 + 注销缓存
      try { await cl.remove(row.remote_path) } catch { /* ignore */ }
      deleteAttachmentsForParent(row.id)
      removeLocalCache(row)
      setBackupStatus(row.id, 'deleted')
      summary.deleted++
    } else if (localExists && !remoteExists) {
      // 远端已删 -> 删本地 + 注销缓存
      try { if (row.local_path) fs.unlinkSync(row.local_path) } catch { /* ignore */ }
      removeLocalCache(row)
      setBackupStatus(row.id, 'deleted')
      for (const a of listAttachments(row.id)) {
        if (a.local_path) { try { fs.unlinkSync(a.local_path) } catch { /* ignore */ } }
        setAttachmentStatus(a.id, 'deleted')
      }
      summary.deleted++
    }
  }
}

interface SyncSummary {
  uploaded: number
  downloaded: number
  deleted: number
  errors: string[]
}

/**
 * 手动触发同步（UI 按钮调用）。可选按 user / folder 过滤。
 * 暂未启用定时触发（配置项 openlist.syncInterval 预留，注明未生效）。
 */
export async function runSyncNow(opts: { user?: string; folder?: 'cache' | 'music' } = {}): Promise<SyncSummary> {
  const cfg = getConfig()
  if (!cfg.enable) throw new Error('OpenList 未启用')
  const cl = getClient()
  if (!cl) throw new Error('OpenList 客户端不可用')
  const summary: SyncSummary = { uploaded: 0, downloaded: 0, deleted: 0, errors: [] }
  for (const entry of cfg.userBackups) {
    if (!entry.enabled) continue
    if (opts.user && entry.user !== opts.user) continue
    const mode = effectiveMode(entry, cfg)
    const folders: Array<'cache' | 'music'> = opts.folder ? [opts.folder] : (['cache', 'music'] as const)
    for (const ft of folders) {
      const dir = resolveUserDir(entry, ft, cfg)
      if (!dir) continue
      try {
        if (mode === 'download' || mode === 'sync') await downloadDirection(entry, cl, cfg, ft, summary)
        if (mode === 'sync') {
          await uploadDirection(entry, cl, cfg, ft, summary)
          await deletionDetection(entry, cl, cfg, ft, summary)
        } else if (mode === 'upload' || mode === 'upload-delete') {
          await uploadDirection(entry, cl, cfg, ft, summary)
        }
      } catch (e: any) {
        summary.errors.push(`${entry.user}/${ft}: ${e?.message || e}`)
      }
    }
  }
  return summary
}

// ---------- 查询 ----------

export function listBackups(): any[] {
  ensureBackupTables()
  const files = listAllBackups()
  return files.map((f) => ({ ...f, attachments: listAttachments(f.id) }))
}
