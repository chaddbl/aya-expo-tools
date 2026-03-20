/**
 * AYA Expo Tools — Loop Generator
 *
 * Gera arquivos de loop (ffmpeg concat -c copy) automaticamente
 * quando um vídeo é atribuído a uma TV.
 *
 * Inspirado no MP4Museum: loop seamless sem gap, sem re-encode.
 *
 * Fluxo:
 *   1. assignVideo() chamado (via API /api/media/assign)
 *   2. Verifica se já existe loop para esse vídeo
 *   3. Se não, gera em background (ffmpeg concat)
 *   4. Callback quando pronto → cast automático
 */

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const FFMPEG = 'C:\\ffmpeg\\ffmpeg.exe'
const FFPROBE = 'C:\\ffmpeg\\ffprobe.exe'
const LOOPS_DIR = fs.existsSync('D:\\aya-expo-data\\loops')
  ? 'D:\\aya-expo-data\\loops'
  : path.join(__dirname, '..', 'media', 'loops')

const TARGET_HOURS = 12  // gera loop de 12h (cobre qualquer dia de expo)
const _generating = new Map()  // sourceFile → { promise, progress }

// Ensure dir
try { fs.mkdirSync(LOOPS_DIR, { recursive: true }) } catch {}

/**
 * Get video duration in seconds via ffprobe
 */
function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath
    ], { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        const data = JSON.parse(stdout)
        resolve(parseFloat(data.format.duration) || 0)
      } catch (e) {
        reject(e)
      }
    })
  })
}

/**
 * Generate loop filename from source
 * e.g. "tv1-video.mp4" → "tv1-video-loop.mp4"
 */
function loopFilename(sourceFile) {
  const ext = path.extname(sourceFile)
  const base = path.basename(sourceFile, ext)
  return `${base}-loop${ext}`
}

/**
 * Get the loop URL path for a source video URL
 * e.g. "/media/tv1-video.mp4" → "/loops/tv1-video-loop.mp4"
 */
function getLoopUrl(sourceVideoUrl) {
  const sourceFile = path.basename(sourceVideoUrl)
  return `/loops/${loopFilename(sourceFile)}`
}

/**
 * Check if loop file exists and is valid
 */
function hasLoop(sourceVideoUrl) {
  const loopFile = path.join(LOOPS_DIR, loopFilename(path.basename(sourceVideoUrl)))
  return fs.existsSync(loopFile) && fs.statSync(loopFile).size > 1000
}

/**
 * Check if loop is currently being generated
 */
function isGenerating(sourceVideoUrl) {
  return _generating.has(path.basename(sourceVideoUrl))
}

/**
 * Get generation status
 */
function getStatus() {
  const result = {}
  for (const [file, state] of _generating) {
    result[file] = { status: 'generating', ...state.progress }
  }
  // Add existing loops
  try {
    const files = fs.readdirSync(LOOPS_DIR).filter(f => f.endsWith('-loop.mp4'))
    for (const f of files) {
      const stat = fs.statSync(path.join(LOOPS_DIR, f))
      result[f] = {
        status: 'ready',
        sizeMB: Math.round(stat.size / 1024 / 1024),
        modified: stat.mtime.toISOString(),
      }
    }
  } catch {}
  return result
}

/**
 * Generate a loop file for a source video.
 * Returns promise that resolves with the loop URL when done.
 *
 * @param {string} sourceFilePath — absolute path to source video
 * @param {function} [onReady] — callback(loopUrl) when generation completes
 * @returns {Promise<string>} — loop URL path (e.g. "/loops/xxx-loop.mp4")
 */
async function generate(sourceFilePath, onReady) {
  const sourceFile = path.basename(sourceFilePath)
  const loopFile = loopFilename(sourceFile)
  const loopPath = path.join(LOOPS_DIR, loopFile)
  const loopUrl = `/loops/${loopFile}`

  // Already exists?
  if (fs.existsSync(loopPath) && fs.statSync(loopPath).size > 1000) {
    console.log(`[LoopGen] ${loopFile} already exists — skipping`)
    if (onReady) onReady(loopUrl)
    return loopUrl
  }

  // Already generating?
  if (_generating.has(sourceFile)) {
    console.log(`[LoopGen] ${sourceFile} already generating — waiting`)
    const existing = _generating.get(sourceFile)
    const url = await existing.promise
    if (onReady) onReady(url)
    return url
  }

  // Generate
  const progress = { reps: 0, estimatedMB: 0, started: new Date().toISOString() }

  const promise = (async () => {
    try {
      // Get duration
      const duration = await getDuration(sourceFilePath)
      if (duration <= 0) throw new Error(`Invalid duration: ${duration}`)

      const reps = Math.ceil((TARGET_HOURS * 3600) / duration)
      const estimatedSizeMB = Math.round((fs.statSync(sourceFilePath).size * reps) / 1024 / 1024)
      progress.reps = reps
      progress.estimatedMB = estimatedSizeMB
      progress.duration = duration

      console.log(`[LoopGen] ${sourceFile}: ${duration.toFixed(0)}s × ${reps} reps = ~${TARGET_HOURS}h (~${estimatedSizeMB}MB)`)

      // Write concat list
      const listPath = path.join(LOOPS_DIR, `${sourceFile}.txt`)
      const lines = Array(reps).fill(`file '${sourceFilePath.replace(/\\/g, '/')}'`).join('\n')
      fs.writeFileSync(listPath, lines)

      // Run ffmpeg
      await new Promise((resolve, reject) => {
        const proc = execFile(FFMPEG, [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-c', 'copy',
          loopPath
        ], { timeout: 600000 }, (err) => {  // 10min timeout
          // Clean up list file
          try { fs.unlinkSync(listPath) } catch {}
          if (err) reject(err)
          else resolve()
        })
      })

      const finalSize = fs.statSync(loopPath).size
      console.log(`[LoopGen] ${loopFile} ready — ${Math.round(finalSize / 1024 / 1024)}MB`)

      if (onReady) onReady(loopUrl)
      return loopUrl
    } catch (err) {
      console.error(`[LoopGen] ${sourceFile} failed:`, err.message)
      // Clean up partial file
      try { fs.unlinkSync(loopPath) } catch {}
      throw err
    } finally {
      _generating.delete(sourceFile)
    }
  })()

  _generating.set(sourceFile, { promise, progress })
  return promise
}

/**
 * Delete a loop file
 */
function deleteLoop(sourceVideoUrl) {
  const loopFile = loopFilename(path.basename(sourceVideoUrl))
  const loopPath = path.join(LOOPS_DIR, loopFile)
  try {
    fs.unlinkSync(loopPath)
    console.log(`[LoopGen] Deleted ${loopFile}`)
    return true
  } catch {
    return false
  }
}

module.exports = {
  generate,
  hasLoop,
  isGenerating,
  getLoopUrl,
  getStatus,
  deleteLoop,
  LOOPS_DIR,
}
