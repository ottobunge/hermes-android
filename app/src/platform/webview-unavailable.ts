// Android adaptation layer — NOT part of the vendored desktop renderer.
//
// The desktop's Browser / web-preview pane (app/chat/right-rail/preview-pane)
// hosts pages in Electron's <webview> guest tag. Android's WebView has no
// such tag, so an unpatched `createElement('webview')` yields an inert
// element and a preview that spins forever. Instead, hand the pane an element
// that fails its load through the pane's own `did-fail-load` path: the pane
// shows its load-error card, whose URL link opens the page in the system
// browser (openExternal). `about:blank` (the empty Browser tab) is left alone.
//
// ponytail: explicit unavailability, not an in-app browser — a sandboxed
// <iframe> host is the upgrade path if in-app previews are ever needed.

export const PREVIEW_UNAVAILABLE_MESSAGE =
  'In-app web previews are not available on Android. Tap the address above to open it in your browser.'

function failLoad(element: HTMLElement) {
  const url = element.getAttribute('src') || ''

  if (!url || url === 'about:blank') {
    element.dispatchEvent(new Event('did-stop-loading'))

    return
  }

  element.dispatchEvent(
    Object.assign(new Event('did-fail-load'), { errorDescription: PREVIEW_UNAVAILABLE_MESSAGE, validatedURL: url })
  )
}

export function installWebviewFallback(): void {
  const createElement = document.createElement.bind(document)

  document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const element = createElement(tagName, options)

    if (tagName.toLowerCase() !== 'webview') {
      return element
    }

    // The pane wires its listeners synchronously after creating the tag, so a
    // macrotask later they are all attached. Retry/navigation re-fail.
    const retry = () => setTimeout(() => failLoad(element))
    const target = element as HTMLElement & Record<string, unknown>
    target.reload = retry
    target.reloadIgnoringCache = retry
    // The pane surfaces a rejected loadURL as its load error.
    target.loadURL = (url: string) => {
      element.setAttribute('src', url)

      return Promise.reject(new Error(PREVIEW_UNAVAILABLE_MESSAGE))
    }
    target.getURL = () => element.getAttribute('src') || ''
    retry()

    return element
  }) as typeof document.createElement
}
