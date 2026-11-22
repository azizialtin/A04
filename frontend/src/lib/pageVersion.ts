/**
 * Whether this tab still runs what the server hands out now.
 *
 * A tab keeps the script it loaded. The lab's tab sat on the login page while
 * a release went out, and the next morning's session ran on the release before
 * it. The page shell names its files by their content, so fetching the shell
 * again and comparing the names tells whether the tab has fallen behind.
 */

const RELOADED_FOR = 'a04.reloaded_for'

/** This site's scripts and stylesheets as a page shell names them, or null without a script. */
export function shellFiles(root: ParentNode, base = window.location.href): string | null {
  const origin = new URL(base).origin
  const local = (value: string | null) => {
    if (!value) return null
    try {
      const url = new URL(value, base)
      // A browser extension can add files of its own; they are not a release.
      return url.origin === origin ? url.pathname : null
    } catch {
      return null
    }
  }
  const paths = (selector: string, attribute: string) =>
    Array.from(root.querySelectorAll(selector), (node) =>
      local(node.getAttribute(attribute)),
    ).filter((path): path is string => path !== null)
  const scripts = paths('script[type="module"][src]', 'src')
  if (!scripts.length) return null
  return [...scripts, ...paths('link[rel~="stylesheet"][href]', 'href')].sort().join(' ')
}

// Read once, at start: the shell this tab was given.
let loaded = shellFiles(document)
let reloading = false

async function deployedFiles(timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel)
  try {
    const response = await fetch('/index.html', { cache: 'no-store', signal: controller.signal })
    if (!response.ok) return null
    return shellFiles(new DOMParser().parseFromString(await response.text(), 'text/html'))
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

function remember(files: string): boolean {
  try {
    if (window.sessionStorage.getItem(RELOADED_FOR) === files) return false
    window.sessionStorage.setItem(RELOADED_FOR, files)
    return window.sessionStorage.getItem(RELOADED_FOR) === files
  } catch {
    // Without a note of the attempt, a reload that changes nothing would repeat for ever.
    return false
  }
}

function forget() {
  try {
    window.sessionStorage.removeItem(RELOADED_FOR)
  } catch {
    /* nothing was noted */
  }
}

/** `outdated`: the server has newer files and reloading did not bring them. */
export type PageState = 'current' | 'reloading' | 'outdated' | 'unknown'

/** The browser's own reload, in one place so a screen's tests can stand in for it. */
export function reloadPage() {
  window.location.reload()
}

/**
 * Reload when the server has moved on. Only for screens with nothing to lose:
 * a reload in the middle of a session is the participant's to decide. The
 * answer can arrive after the screen that asked has gone, so the caller aborts
 * `signal` when it no longer wants one; nothing is saved or reloaded after that.
 */
export async function reloadIfOutdated({
  timeoutMs = 4000,
  beforeReload,
  reload = reloadPage,
  signal,
}: {
  timeoutMs?: number
  beforeReload?: () => void
  reload?: () => void
  signal?: AbortSignal
} = {}): Promise<PageState> {
  if (reloading) return 'reloading'
  if (loaded === null || signal?.aborted) return 'unknown'
  const deployed = await deployedFiles(timeoutMs, signal)
  // Another check may have started the reload while this one waited.
  if (reloading) return 'reloading'
  if (deployed === null || signal?.aborted) return 'unknown'
  if (deployed === loaded) {
    forget()
    return 'current'
  }
  if (!remember(deployed)) return 'outdated'
  reloading = true
  beforeReload?.()
  reload()
  return 'reloading'
}

/** Test seam: read the document's shell again and drop the reload state. */
export function __reset() {
  loaded = shellFiles(document)
  reloading = false
}
