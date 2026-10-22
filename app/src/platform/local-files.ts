// Android adaptation layer — NOT part of the vendored desktop renderer.
//
// The desktop bridge hands the renderer filesystem PATHS (selectPaths,
// getPathForFile, saveImageBuffer…) and later reads them back by path
// (readFileDataUrl, readFileText). A WebView has no filesystem, so picked /
// pasted / dropped blobs live in memory under a synthetic path for the life of
// the page. ponytail: in-memory only, lost on reload — persist to Capacitor
// Filesystem if attachments must survive an app restart.

const files = new Map<string, Blob & { name?: string }>()
let seq = 0

export const LOCAL_FILE_PREFIX = '/android-local/'

export function registerBlob(blob: Blob, name: string): string {
  const safe = (name || 'file').replace(/[/\\]/g, '_')
  const path = `${LOCAL_FILE_PREFIX}${++seq}/${safe}`
  files.set(path, blob)

  return path
}

export function registerFile(file: File): string {
  return registerBlob(file, file.name)
}

function lookup(path: string): Blob {
  const blob = files.get(path)

  if (!blob) {
    throw new Error(`File is not available on this device: ${path}`)
  }

  return blob
}

export function readBlobDataUrl(path: string): Promise<string> {
  const blob = lookup(path)

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${path}`))
    reader.readAsDataURL(blob)
  })
}

const TEXT_PREVIEW_MAX_BYTES = 512 * 1024

export async function readBlobText(path: string) {
  const blob = lookup(path)
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer())

  return {
    binary: head.includes(0),
    byteSize: blob.size,
    mimeType: blob.type || 'application/octet-stream',
    path,
    text: await blob.slice(0, TEXT_PREVIEW_MAX_BYTES).text(),
    truncated: blob.size > TEXT_PREVIEW_MAX_BYTES
  }
}

/** <input type=file> picker → synthetic paths ([] on cancel). */
export function pickFiles(options: { directories?: boolean; filters?: Array<{ extensions: string[] }>; multiple?: boolean } = {}): Promise<string[]> {
  if (options.directories) {
    // No directory model on Android: a folder path the gateway can't see is useless.
    return Promise.resolve([])
  }

  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options.multiple !== false
    const exts = options.filters?.flatMap(f => f.extensions).filter(e => e && e !== '*')

    if (exts?.length) {
      input.accept = exts.map(e => `.${e}`).join(',')
    }

    input.onchange = () => resolve([...(input.files ?? [])].map(registerFile))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}
