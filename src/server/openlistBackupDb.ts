/**
 * OpenList 音频备份 - SQLite 元数据库
 * 记录每个待备份/已备份音频文件的本地路径、远端路径与上传状态。
 * 状态机：pending -> uploading -> completed -> verified（失败记 failed）。
 * 使用 Node 内置 node:sqlite（DatabaseSync），与 sqlite 分支同源。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type BackupStatus = 'pending' | 'uploading' | 'completed' | 'verified' | 'failed'

export interface BackupFileRow {
  id: number
  user: string
  folder_type: string
  local_path: string
  remote_path: string
  size: number | null
  name: string | null
  source: string | null
  songmid: string | null
  quality: string | null
  status: BackupStatus
  error: string | null
  created_at: number
  updated_at: number
}

export interface UpsertBackupInput {
  user: string
  folderType: string
  localPath: string
  remotePath: string
  size?: number | null
  name?: string | null
  source?: string | null
  songmid?: string | null
  quality?: string | null
  status?: BackupStatus
}

let dbInstance: DatabaseSync | null = null

function getDataPath(): string {
  const lp = (globalThis as any).lx?.dataPath
  return typeof lp === 'string' && lp ? lp : path.join(process.cwd(), 'data')
}

export function getBackupDb(): DatabaseSync {
  if (dbInstance) return dbInstance
  const dir = getDataPath()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'openlist-backup.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(`CREATE TABLE IF NOT EXISTS openlist_backup_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    folder_type TEXT NOT NULL,
    local_path TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    size INTEGER,
    name TEXT,
    source TEXT,
    songmid TEXT,
    quality TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user, folder_type, local_path)
  )`)
  dbInstance = db
  return db
}

export function ensureBackupTables(): void {
  getBackupDb()
}

export function closeBackupDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}

export function upsertBackupFile(input: UpsertBackupInput): BackupFileRow {
  const db = getBackupDb()
  const now = Date.now()
  const status = input.status ?? 'pending'
  const stmt = db.prepare(`INSERT INTO openlist_backup_files
    (user, folder_type, local_path, remote_path, size, name, source, songmid, quality, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user, folder_type, local_path) DO UPDATE SET
      remote_path = excluded.remote_path,
      size = excluded.size,
      name = excluded.name,
      source = excluded.source,
      songmid = excluded.songmid,
      quality = excluded.quality,
      status = excluded.status,
      updated_at = excluded.updated_at`)
  stmt.run(
    input.user, input.folderType, input.localPath, input.remotePath,
    input.size ?? null, input.name ?? null, input.source ?? null,
    input.songmid ?? null, input.quality ?? null, status, now, now,
  )
  return getBackupByLocalPath(input.user, input.folderType, input.localPath)!
}

export function setBackupStatus(
  id: number,
  status: BackupStatus,
  opts: { error?: string | null; size?: number | null; name?: string | null; remotePath?: string | null } = {},
): void {
  const db = getBackupDb()
  const sets: string[] = ['status = ?', 'updated_at = ?']
  const params: any[] = [status, Date.now()]
  if (opts.error !== undefined) { sets.push('error = ?'); params.push(opts.error) }
  if (opts.size !== undefined) { sets.push('size = ?'); params.push(opts.size) }
  if (opts.name !== undefined) { sets.push('name = ?'); params.push(opts.name) }
  if (opts.remotePath !== undefined) { sets.push('remote_path = ?'); params.push(opts.remotePath) }
  params.push(id)
  db.prepare(`UPDATE openlist_backup_files SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function getBackupByLocalPath(user: string, folderType: string, localPath: string): BackupFileRow | null {
  const db = getBackupDb()
  const row = db.prepare(
    'SELECT * FROM openlist_backup_files WHERE user = ? AND folder_type = ? AND local_path = ?',
  ).get(user, folderType, localPath) as BackupFileRow | undefined
  return row ?? null
}

export function listBackupByStatus(status: BackupStatus): BackupFileRow[] {
  const db = getBackupDb()
  return db.prepare(
    'SELECT * FROM openlist_backup_files WHERE status = ? ORDER BY updated_at ASC',
  ).all(status) as unknown as BackupFileRow[]
}

export function listAllBackups(): BackupFileRow[] {
  const db = getBackupDb()
  return db.prepare('SELECT * FROM openlist_backup_files ORDER BY updated_at DESC').all() as unknown as BackupFileRow[]
}
