import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getUserDirname } from '@/user'

/**
 * 「我的评分」快照（第三种备份类型）。
 * 评星数据独立于歌单/不喜欢，存放在 <用户目录>/subsonic-meta.json，
 * 因此独立成一套快照目录 <用户目录>/rating/snapshot/，与另外两类并列展示。
 */
export interface RatingMeta {
  starredAlbums: string[]
  starredArtists: string[]
  starredArtistNames: string[]
  ratings: Record<string, number>
}

export interface RatingSnapshotItem {
  id: string
  time: number
  size: number
  origin: 'imported' | 'auto'
}

interface RatingSnapshotInfo {
  imported: string[]
}

const emptyMeta = (): RatingMeta => ({ starredAlbums: [], starredArtists: [], starredArtistNames: [], ratings: {} })

const userDir = (username: string) => path.join(global.lx.userPath, getUserDirname(username))
const metaPath = (username: string) => path.join(userDir(username), 'subsonic-meta.json')
const ratingDir = (username: string) => path.join(userDir(username), 'rating')
const snapshotDir = (username: string) => path.join(ratingDir(username), 'snapshot')
const infoPath = (username: string) => path.join(ratingDir(username), 'snapshotInfo.json')
const snapshotPath = (username: string, id: string) => path.join(snapshotDir(username), `snapshot_${id}`)

const normalizeMeta = (data: any): RatingMeta => ({
  starredAlbums: Array.isArray(data?.starredAlbums) ? data.starredAlbums : [],
  starredArtists: Array.isArray(data?.starredArtists) ? data.starredArtists : [],
  starredArtistNames: Array.isArray(data?.starredArtistNames) ? data.starredArtistNames : [],
  ratings: data?.ratings && typeof data.ratings === 'object' && !Array.isArray(data.ratings) ? data.ratings : {},
})

const readMeta = (username: string): RatingMeta => {
  try {
    if (fs.existsSync(metaPath(username))) return normalizeMeta(JSON.parse(fs.readFileSync(metaPath(username), 'utf8')))
  } catch { /* 损坏时按空评分处理 */ }
  return emptyMeta()
}

const writeMeta = (username: string, meta: RatingMeta) => {
  fs.mkdirSync(path.dirname(metaPath(username)), { recursive: true })
  fs.writeFileSync(metaPath(username), JSON.stringify(meta), 'utf8')
}

const readInfo = (username: string): RatingSnapshotInfo => {
  try {
    if (fs.existsSync(infoPath(username))) {
      const data = JSON.parse(fs.readFileSync(infoPath(username), 'utf8'))
      if (Array.isArray(data.imported)) return { imported: data.imported }
    }
  } catch { /* ignore */ }
  return { imported: [] }
}

const writeInfo = (username: string, info: RatingSnapshotInfo) => {
  fs.mkdirSync(ratingDir(username), { recursive: true })
  fs.writeFileSync(infoPath(username), JSON.stringify(info), 'utf8')
}

const ensureDirs = (username: string) => fs.mkdirSync(snapshotDir(username), { recursive: true })

const md5 = (text: string) => createHash('md5').update(text).digest('hex')

/** 按当前评分内容生成（或复用）一份系统快照，返回快照 id */
export const createRatingSnapshot = async (username: string): Promise<string> => {
  const meta = readMeta(username)
  const id = md5(JSON.stringify(meta))
  ensureDirs(username)
  const file = snapshotPath(username, id)
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(meta), 'utf8')
  return id
}

/** 保存用户导入的评分备份：按原文件名落盘、保留文件时间、显式登记来源 */
export const saveRatingImport = async (username: string, name: string, meta: RatingMeta, time: number): Promise<void> => {
  ensureDirs(username)
  const file = snapshotPath(username, name)
  fs.writeFileSync(file, JSON.stringify(meta), 'utf8')
  if (time) {
    const date = new Date(time)
    fs.utimesSync(file, date, date)
  }
  const info = readInfo(username)
  if (!info.imported.includes(name)) {
    info.imported.push(name)
    writeInfo(username, info)
  }
}

export const listRatingSnapshots = async (username: string): Promise<RatingSnapshotItem[]> => {
  ensureDirs(username)
  const info = readInfo(username)
  const list: RatingSnapshotItem[] = []
  for (const file of fs.readdirSync(snapshotDir(username))) {
    if (!file.startsWith('snapshot_')) continue
    const id = file.slice('snapshot_'.length)
    try {
      const stat = fs.statSync(snapshotPath(username, id))
      list.push({
        id,
        time: stat.mtimeMs,
        size: stat.size,
        origin: info.imported.includes(id) ? 'imported' : 'auto',
      })
    } catch { /* 文件已消失 */ }
  }
  return list.sort((a, b) => b.time - a.time)
}

export const readRatingSnapshot = async (username: string, id: string): Promise<RatingMeta | null> => {
  try {
    const file = snapshotPath(username, id)
    if (!fs.existsSync(file)) return null
    return normalizeMeta(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch { return null }
}

/** 回滚：把快照内容写回 subsonic-meta.json（Subsonic 每次请求会重新预读该文件，缓存自动刷新） */
export const restoreRatingSnapshot = async (username: string, id: string): Promise<void> => {
  const meta = await readRatingSnapshot(username, id)
  if (!meta) throw new Error('Rating snapshot not found')
  writeMeta(username, meta)
}

export const deleteRatingSnapshot = async (username: string, id: string): Promise<boolean> => {
  const file = snapshotPath(username, id)
  if (!fs.existsSync(file)) return false
  fs.unlinkSync(file)
  const info = readInfo(username)
  const index = info.imported.indexOf(id)
  if (index >= 0) {
    info.imported.splice(index, 1)
    writeInfo(username, info)
  }
  return true
}
