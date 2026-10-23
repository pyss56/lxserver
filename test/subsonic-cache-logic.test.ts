/**
 * Subsonic 缓存/格式决策逻辑（后端）单元测试
 *
 * 运行: npx tsx --test test/subsonic-cache-logic.test.ts   (或 npm run test:unit)
 *
 * 通过真实导出的 subsonicHandler 单例，直接驱动本次新增的私有决策方法
 * (getCacheProbeOrder / isQualityOverCap / shouldTranscodeFormat /
 *  getRequestedAudioFormat / getSourceContainer)，验证确定性缓存探测规则
 * (精确优先 + cap 内降序) 与"格式优先满足"分支。无需启动服务器、无需 ffmpeg、无需音乐源网络。
 *
 * 说明: 完整协议联调(真实出流/转码)需在具备 ffmpeg + 已配置用户 + 可达音乐源
 *        的环境中启动服务后用 /rest/stream、/rest/download 请求验证(见对话中的 curl 示例)。
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import defaultConfig from '../src/defaultConfig'

// 必须在动态 import subsonic 模块之前设置 global.lx，避免模块顶层依赖缺失
const g = globalThis as any
g.lx = {
  config: { 'subsonic.quality.priority': 'flac,320k,128k' },
  dataPath: process.cwd(),
  userPath: process.cwd(),
}

let H: any
before(async () => {
  const mod = await import('../src/server/subsonic')
  H = mod.subsonicHandler
})

// ───────────────────────── getCacheProbeOrder (确定性: 精确优先 + cap 内降序) ─────────────────────────
test('getCacheProbeOrder: 精确优先 + cap 内降序, 严格硬上限', () => {
  // 上限 128: 仅 128k 在 cap 内
  assert.deepEqual(H.getCacheProbeOrder('128k', 128), { qualities: ['128k'] })
  // 上限 320: 320k 与 128k 都在 cap 内, 降序 320k,128k; 精确 128k 提到最前
  assert.deepEqual(H.getCacheProbeOrder('128k', 320), { qualities: ['128k', '320k'] })
  // 请求 320k, 上限 320: 精确 320k 在前, 128k 在后(更大优先 + 精确优先)
  assert.deepEqual(H.getCacheProbeOrder('320k', 320), { qualities: ['320k', '128k'] })
  // 无上限: 全部在 cap 内, 降序 flac,320k,128k; 精确 128k 提到最前
  assert.deepEqual(H.getCacheProbeOrder('128k', 0), { qualities: ['128k', 'flac', '320k'] })
  // 请求 flac, 无上限: 精确 flac 在前
  assert.deepEqual(H.getCacheProbeOrder('flac', 0), { qualities: ['flac', '320k', '128k'] })
})

test('getCacheProbeOrder: 超过 cap 的音质绝不进入候选', () => {
  // 请求 flac, 上限 320: flac(>320) 被剔除, 只剩 320k,128k
  assert.deepEqual(H.getCacheProbeOrder('flac', 320), { qualities: ['320k', '128k'] })
  // 请求 320k, 上限 128: 320k(>128) 被剔除, 只剩 128k(回退到上限内最高可用)
  assert.deepEqual(H.getCacheProbeOrder('320k', 128), { qualities: ['128k'] })
})

test('优先级列表影响可用音质与顺序', () => {
  g.lx.config['subsonic.quality.priority'] = 'flac,128k' // 无 320k
  assert.deepEqual(H.getCacheProbeOrder('320k', 0), { qualities: ['320k', 'flac', '128k'] })
  g.lx.config['subsonic.quality.priority'] = 'flac,320k,128k' // 还原
})

// ───────────────────────── isQualityOverCap ─────────────────────────
test('isQualityOverCap: 超 maxBitrate 为 true, 等于或不设上限为 false', () => {
  assert.equal(H.isQualityOverCap('flac', 128), true)
  assert.equal(H.isQualityOverCap('320k', 128), true)
  assert.equal(H.isQualityOverCap('128k', 128), false)
  assert.equal(H.isQualityOverCap('320k', 320), false)
  assert.equal(H.isQualityOverCap('flac', 0), false) // maxBitrate=0 = 无上限
})

// ───────────────────────── getRequestedAudioFormat ─────────────────────────
test('getRequestedAudioFormat: 解析/归一化/忽略 raw|native|空', () => {
  assert.equal(H.getRequestedAudioFormat(new URLSearchParams('format=mp3')), 'mp3')
  assert.equal(H.getRequestedAudioFormat(new URLSearchParams('format=FLAC')), 'flac')
  assert.equal(H.getRequestedAudioFormat(new URLSearchParams('format=raw')), '')
  assert.equal(H.getRequestedAudioFormat(new URLSearchParams('format=native')), '')
  assert.equal(H.getRequestedAudioFormat(new URLSearchParams('')), '')
})

// ───────────────────────── shouldTranscodeFormat ─────────────────────────
test('shouldTranscodeFormat: 容器不符需转码, 相符/无要求/不支持目标则否', () => {
  const mp3 = new URLSearchParams('format=mp3')
  const flac = new URLSearchParams('format=flac')
  const wav = new URLSearchParams('format=wav') // 不在支持列表
  const none = new URLSearchParams('')
  assert.equal(H.shouldTranscodeFormat(mp3, 'song.flac'), true)
  assert.equal(H.shouldTranscodeFormat(mp3, 'song.mp3'), false)
  assert.equal(H.shouldTranscodeFormat(flac, 'song.flac'), false)
  assert.equal(H.shouldTranscodeFormat(wav, 'song.mp3'), false) // 目标不支持
  assert.equal(H.shouldTranscodeFormat(none, 'song.flac'), false) // 无格式要求
})

// ───────────────────────── getSourceContainer ─────────────────────────
test('getSourceContainer: 从 URL 扩展名或音质推断容器', () => {
  assert.equal(H.getSourceContainer('http://a.b/c.mp3?x=1', '128k'), 'mp3')
  assert.equal(H.getSourceContainer('http://a.b/c.MP3?x=1', '128k'), 'mp3') // 大小写不敏感
  assert.equal(H.getSourceContainer('http://a.b/c.flac', 'flac'), 'flac')
  assert.equal(H.getSourceContainer('http://a.b/c', 'flac'), 'flac') // 无扩展名按音质
  assert.equal(H.getSourceContainer('http://a.b/c', '128k'), 'mp3')
})

// ───────────────────────── 默认值与配置项清理(兼容性) ─────────────────────────
test('defaultConfig: playCacheFirst 默认 false(避免服务器自担出向流量/代理字节)', () => {
  assert.equal(defaultConfig['subsonic.playCacheFirst'], false)
})

test('defaultConfig: 已合并/移除的冗余配置项不再存在', () => {
  assert.equal('subsonic.transcode.onQualityMiss' in defaultConfig, false, 'onQualityMiss 应已合并进 enabled')
  assert.equal('subsonic.cache.fallback' in defaultConfig, false, 'cache.fallback 枚举应已删除')
  assert.equal('subsonic.quality.clientCapMode' in defaultConfig, false, 'clientCapMode 配置项应已彻底移除')
})

test('compat: 旧配置项(clientCapMode/onQualityMiss/cache.fallback)不影响确定性缓存探测', () => {
  // 模拟用户旧配置残留这些键, 验证 getCacheProbeOrder 完全不读取它们, 输出与干净配置一致
  const baseline = H.getCacheProbeOrder('128k', 320)
  g.lx.config['subsonic.quality.clientCapMode'] = 'soft'
  g.lx.config['subsonic.transcode.onQualityMiss'] = true
  g.lx.config['subsonic.cache.fallback'] = 'transcode'
  assert.deepEqual(H.getCacheProbeOrder('128k', 320), baseline)
  // 清理, 避免影响其它用例
  delete g.lx.config['subsonic.quality.clientCapMode']
  delete g.lx.config['subsonic.transcode.onQualityMiss']
  delete g.lx.config['subsonic.cache.fallback']
})
