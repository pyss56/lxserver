/**
 * OpenList / alist 存储客户端（音频备份专用）。
 * 契约已对真实实例(天翼云盘 tyCloud 挂载)实测确认：
 *  - 登录 POST /api/auth/login -> data.token
 *  - 上传 PUT /api/fs/put（file-path 头 + 原始字节体），部分构建写完文件仍返 500，
 *    因此成功与否以 getInfo 轮询确认文件存在为准
 *  - 校验/直链 POST /api/fs/get -> { raw_url, size, name }
 *  - 建目录 POST /api/fs/mkdir；删除 POST /api/fs/remove
 */
import fs from 'node:fs'
import path from 'node:path'

export interface OpenListClientConfig {
  endpoint: string
  username: string
  password: string
  token?: string
  root?: string
}

export interface OpenListFileInfo {
  size: number
  rawUrl?: string
  openlistUrl?: string
  name?: string
}

const encodePath = (p: string) => p.split('/').map((s) => encodeURIComponent(s)).join('/')

// OpenList 的 last-modified 期望 Go 参考布局 "Jan 2, 2006 15:04:05 PM -07"，否则部分构建 PUT 返回 500
function goTime(d = new Date()): string {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  const p = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')
  const om = String(Math.abs(off) % 60).padStart(2, '0')
  return `${M} ${d.getDate()}, ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} PM ${sign}${oh}${om}`
}

export class OpenListClient {
  private endpoint: string
  private username: string
  private password: string
  private directToken?: string
  private root: string
  private token: string | null = null

  constructor(cfg: OpenListClientConfig) {
    this.endpoint = (cfg.endpoint || '').replace(/\/+$/, '')
    this.username = cfg.username || ''
    this.password = cfg.password || ''
    this.directToken = cfg.token || undefined
    this.root = (cfg.root || '/').replace(/\/+$/, '') || '/'
  }

  private async ensureToken(): Promise<string> {
    if (this.directToken) return this.directToken
    if (this.token) return this.token
    const resp = await fetch(`${this.endpoint}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    })
    const data: any = await resp.json().catch(() => ({}))
    if (data?.code !== 200 || !data?.data?.token) {
      throw new Error('OpenList 登录失败：' + (data?.message || resp.status))
    }
    this.token = data.data.token
    return this.token!
  }

  private authHeader(): Record<string, string> {
    return { Authorization: this.token || this.directToken || '' }
  }

  /** 拼接完整远端路径：root + 相对路径 */
  resolveRemotePath(relativePath: string): string {
    const rel = relativePath.replace(/^\/+/, '')
    return `${this.root}/${rel}`.replace(/\/+/g, '/')
  }

  async listDir(p: string): Promise<any> {
    await this.ensureToken()
    const resp = await fetch(`${this.endpoint}/api/fs/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader() },
      body: JSON.stringify({ path: p, password: '', page: 1, per_page: 100 }),
    })
    const data: any = await resp.json().catch(() => ({}))
    if (data?.code !== 200) throw new Error('OpenList 列目录失败：' + (data?.message || resp.status))
    return data.data || {}
  }

  async mkdir(dir: string): Promise<void> {
    await this.ensureToken()
    const resp = await fetch(`${this.endpoint}/api/fs/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader() },
      body: JSON.stringify({ path: dir }),
    })
    const data: any = await resp.json().catch(() => ({}))
    if (data?.code !== 200 && !String(data?.message || '').toLowerCase().includes('exist')) {
      throw new Error('OpenList 创建目录失败：' + (data?.message || resp.status))
    }
  }

  private async pollFileInfo(remotePath: string, timeoutMs = 30_000): Promise<OpenListFileInfo | null> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        const info = await this.getFileInfo(remotePath)
        if (info && info.size != null) return info
      } catch { /* 尚未就绪，继续轮询 */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    return null
  }

  /**
   * 上传本地文件到完整远端路径(remotePath)。
   * 采用 OpenList PUT + file-path 头 + 原始字节体；以 getInfo 确认落盘，规避服务端 500-on-success。
   */
  async upload(localPath: string, remotePath: string, signal?: AbortSignal): Promise<OpenListFileInfo> {
    await this.ensureToken()
    const buf = await fs.promises.readFile(localPath)
    const headers: Record<string, string> = {
      ...this.authHeader(),
      'Content-Type': 'application/octet-stream',
      'file-path': remotePath,
      overwrite: 'true',
      password: '',
      'last-modified': goTime(),
    }
    const resp = await fetch(`${this.endpoint}/api/fs/put`, {
      method: 'PUT',
      headers,
      body: buf,
      signal,
    })
    const text = await resp.text()
    let data: any = {}
    try { data = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
    const info = await this.pollFileInfo(remotePath)
    if (info && info.size != null) {
      return { ...info, name: info.name || path.basename(remotePath) }
    }
    throw new Error('OpenList 上传失败：' + (data?.message || resp.status) + ' | body=' + text.slice(0, 300))
  }

  async getFileInfo(remotePath: string): Promise<OpenListFileInfo> {
    await this.ensureToken()
    const resp = await fetch(`${this.endpoint}/api/fs/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader() },
      body: JSON.stringify({ path: remotePath, password: '' }),
    })
    const data: any = await resp.json().catch(() => ({}))
    if (data?.code !== 200) throw new Error('OpenList 获取文件信息失败：' + (data?.message || resp.status))
    const d = data.data || {}
    return {
      size: Number(d.size ?? 0),
      rawUrl: d.raw_url || undefined,
      openlistUrl: `${this.endpoint}/d/${encodePath(remotePath.replace(/^\/+/, ''))}`,
      name: d.name,
    }
  }

  async remove(remotePath: string): Promise<void> {
    await this.ensureToken()
    const dir = path.posix.dirname(remotePath)
    const name = path.posix.basename(remotePath)
    const resp = await fetch(`${this.endpoint}/api/fs/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader() },
      body: JSON.stringify({ dir, names: [name] }),
    })
    const data: any = await resp.json().catch(() => ({}))
    if (data?.code !== 200) throw new Error('OpenList 删除失败：' + (data?.message || resp.status))
  }
}
