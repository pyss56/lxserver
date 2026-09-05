// ============================================================
// 原生 getMusicUrl 兜底实现
// ------------------------------------------------------------
// 背景：本分支 api-source.js 的 getMusicUrl 只走自定义 UserApi 音源，
// 一旦第三方音源后端挂掉（本项目现状），播放就全死。
// 这里提供"直连各平台官方接口"的原生实现，作为 UserApi 失败时的兜底。
//
// 环境与约束（本机代理 127.0.0.1:64338）：
//   - 本项目的 httpFetch（基于 needle）在走该代理时**无法隧穿 HTTPS**
//     （返回 "plain HTTP request was sent to HTTPS port"），故 needle 只能打 http://。
//   - 但原生 Node https.request + HttpsProxyAgent 可以正常隧穿该代理的 HTTPS。
//   - 因此本模块的 WY 走 http://music.163.com（weapi，http 即可）；其余平台若要补，
//     应改用原生 https.request 而非 httpFetch，才能触达 https 接口。
//
// 已验证可用的平台：
//   - wy (网易云)：weapi 加密，http://music.163.com/weapi/... 实测返回可播放 mp3
//     （含 云宫迅音、阴天 等歌曲的 WY 版本均已验证可播）。
// 其余平台为何暂未实现（已逐一探明，非偷懒）：
//   - kw (酷我)：getPlayUrl 需要 kw_token（首页不再下发 Set-Cookie），本环境拿不到 → 死。
//   - tx (QQ)：musicu.fcg 的 vkey 现在被风控 code=104009（invalidq）拦截，裸请求拿不到 purl → 死。
//   - kg (酷狗)：play/getdata 即便带上合法 FileHash 也返回 err_code=30020（版权/区域限制）→ 死。
//   - mg (咪咕)：接口强制 https + 签名，同上需原生 https + sign → 暂未实现。
// 结论：在当前环境下，原生兜底能稳定救活的只有 网易云(wy) 这一个大盘。
// ============================================================

import { httpFetch } from '../request'
import { createCipheriv, publicEncrypt, randomBytes, constants } from 'crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ---------- 网易云 weapi ----------
const iv = Buffer.from('0102030405060708')
const presetKey = Buffer.from('0CoJUm6Qyw8W8jud')
const linuxapiKey = Buffer.from('rFgB&h#%2?^eDg:Q')
const base62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const publicKey = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----'

const aesEncrypt = (buffer, mode, key, iv) => {
  const cipher = createCipheriv(mode, key, iv)
  return Buffer.concat([cipher.update(buffer), cipher.final()])
}
const rsaEncrypt = (buffer, key) => {
  buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer])
  return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, buffer)
}
const weapi = object => {
  const text = JSON.stringify(object)
  const secretKey = randomBytes(16).map(n => base62.charCodeAt(n % 62))
  return {
    params: aesEncrypt(Buffer.from(aesEncrypt(Buffer.from(text), 'aes-128-cbc', presetKey, iv).toString('base64')), 'aes-128-cbc', secretKey, iv).toString('base64'),
    encSecKey: rsaEncrypt(secretKey.reverse(), publicKey).toString('hex'),
  }
}

const QUALITY_MAP = { '128k': 'standard', '320k': 'higher', flac: 'lossless', 'flac24bit': 'lossless', hires: 'hires', '': 'standard' }

const getWyUrl = async (songInfo, type) => {
  const songId = songInfo.songmid || songInfo.songId
  if (!songId) throw new Error('wy: 缺少 songmid')
  const level = QUALITY_MAP[type] || 'standard'
  const { params, encSecKey } = weapi({ ids: `[${songId}]`, level, encodeType: 'mp3' })
  const resp = await httpFetch('http://music.163.com/weapi/song/enhance/player/url/v1?csrf_token=', {
    method: 'post',
    headers: { Referer: 'http://music.163.com/', 'Content-Type': 'application/x-www-form-urlencoded' },
    form: { params, encSecKey },
    timeout: 20000,
  }).promise
  if (resp.statusCode !== 200 || !resp.body || resp.body.code !== 200) {
    throw new Error(`wy: 接口返回异常 (${resp.statusCode})`)
  }
  const url = resp.body.data && resp.body.data[0] && resp.body.data[0].url
  if (!url) throw new Error('wy: 未返回播放链接')
  return url
}

// ---------- 平台分发 ----------
const handlers = {
  wy: getWyUrl,
  // kw / tx / mg / kg: 见文件顶部 TODO，暂不支持时抛出明确错误交由上层处理
}

/**
 * 原生获取播放链接
 * @param {string} source 平台 id: wy | tx | kw | kg | mg
 * @param {object} songInfo 含 songmid / songId / hash 等
 * @param {string} type 音质: 128k | 320k | flac ...
 * @returns {Promise<string>} 播放链接
 */
export const getNativeMusicUrl = async (source, songInfo, type) => {
  const handler = handlers[source]
  if (!handler) throw new Error(`原生音源暂不支持平台: ${source}`)
  return handler(songInfo, type)
}

export default { getNativeMusicUrl }
