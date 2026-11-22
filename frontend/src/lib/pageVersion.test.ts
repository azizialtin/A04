import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { __reset, reloadIfOutdated, shellFiles } from './pageVersion'

const shell = (script: string, style = '/assets/index-CYZ1VFX5.css') => `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <title>A04</title>
    <script type="module" crossorigin src="${script}"></script>
    <link rel="stylesheet" crossorigin href="${style}">
  </head>
  <body><div id="root"></div></body>
</html>`

const RELEASED = '/assets/index-Cq5AsONW.js'
const BEFORE = '/assets/index-BQqQIViu.js'

function parse(html: string) {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** Put this tab on the given release, as if it had been loaded with that shell. */
function loadTab(script: string | null, style = '/assets/index-CYZ1VFX5.css') {
  document.head.querySelectorAll('script, link').forEach((node) => node.remove())
  if (script) {
    const entry = document.createElement('script')
    entry.type = 'module'
    entry.src = script
    const sheet = document.createElement('link')
    sheet.rel = 'stylesheet'
    sheet.href = style
    document.head.append(entry, sheet)
  }
  __reset()
}

type Fetch = (input: string, init: { signal: AbortSignal }) => Promise<Response>

function serve(body: string | Fetch, status = 200) {
  const fetch = vi.fn<Fetch>(
    typeof body === 'string' ? async () => new Response(body, { status }) : body,
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => {
  window.sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  loadTab(null)
})

test('a shell is known by the scripts and stylesheets it names', () => {
  expect(shellFiles(parse(shell(RELEASED)))).toBe(
    '/assets/index-CYZ1VFX5.css /assets/index-Cq5AsONW.js',
  )
  // The same files in another order, or by full address, are the same release.
  const reordered = parse(
    `<link rel="stylesheet" href="${location.origin}/assets/index-CYZ1VFX5.css"><script type="module" src="assets/index-Cq5AsONW.js"></script>`,
  )
  expect(shellFiles(reordered, `${location.origin}/`)).toBe(shellFiles(parse(shell(RELEASED))))
  expect(shellFiles(parse(shell(BEFORE)))).not.toBe(shellFiles(parse(shell(RELEASED))))
  // A release that only restyles the page changes the stylesheet's name alone.
  expect(shellFiles(parse(shell(RELEASED, '/assets/index-Cyturphc.css')))).not.toBe(
    shellFiles(parse(shell(RELEASED))),
  )
})

test('files from elsewhere and pages without a script are not a release', () => {
  const extended = parse(
    shell(RELEASED).replace(
      '</head>',
      '<script type="module" src="chrome-extension://abcdef/content.js"></script><link rel="stylesheet" href="https://fonts.example/a.css"></head>',
    ),
  )
  expect(shellFiles(extended)).toBe(shellFiles(parse(shell(RELEASED))))
  expect(shellFiles(parse('<html><body><h1>502 Bad Gateway</h1></body></html>'))).toBeNull()
  expect(shellFiles(parse('<script src="/classic.js"></script>'))).toBeNull()
  expect(shellFiles(parse('<script type="module">inline()</script>'))).toBeNull()
  expect(shellFiles(parse('<link rel="stylesheet" href="/only.css">'))).toBeNull()
})

test('the development shell compares equal to itself', () => {
  const development =
    '<script type="module" src="/@vite/client"></script><script type="module" src="/src/main.tsx"></script>'
  expect(shellFiles(parse(development))).toBe('/@vite/client /src/main.tsx')
})

test('a tab on the released files is current and is left alone', async () => {
  loadTab(RELEASED)
  const fetch = serve(shell(RELEASED))
  const reload = vi.fn()
  window.sessionStorage.setItem('a04.reloaded_for', 'something older')

  expect(await reloadIfOutdated({ reload })).toBe('current')

  expect(reload).not.toHaveBeenCalled()
  // Asked of the server itself, never of a cache.
  expect(fetch).toHaveBeenCalledWith(
    '/index.html',
    expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
  )
  // An earlier attempt is over once the tab has caught up.
  expect(window.sessionStorage.getItem('a04.reloaded_for')).toBeNull()
})

test('a tab left behind by a release reloads, after its caller has saved what it needs', async () => {
  loadTab(BEFORE, '/assets/index-Cyturphc.css')
  serve(shell(RELEASED))
  const order: string[] = []
  const reload = vi.fn(() => order.push('reload'))

  expect(await reloadIfOutdated({ reload, beforeReload: () => order.push('save') })).toBe(
    'reloading',
  )

  expect(order).toEqual(['save', 'reload'])
  expect(window.sessionStorage.getItem('a04.reloaded_for')).toBe(
    '/assets/index-CYZ1VFX5.css /assets/index-Cq5AsONW.js',
  )
})

test('a restyled release counts as new although the script kept its name', async () => {
  loadTab(RELEASED, '/assets/index-Cyturphc.css')
  serve(shell(RELEASED))
  const reload = vi.fn()
  expect(await reloadIfOutdated({ reload })).toBe('reloading')
  expect(reload).toHaveBeenCalledOnce()
})

test('a reload that did not bring the release is not repeated', async () => {
  loadTab(BEFORE)
  serve(shell(RELEASED))
  const reload = vi.fn()
  expect(await reloadIfOutdated({ reload })).toBe('reloading')

  // The page comes back on the old files: same tab, same session storage.
  loadTab(BEFORE)
  const save = vi.fn()
  expect(await reloadIfOutdated({ reload, beforeReload: save })).toBe('outdated')
  expect(await reloadIfOutdated({ reload, beforeReload: save })).toBe('outdated')
  expect(reload).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()

  // A later release is a new reason to try.
  serve(shell('/assets/index-NEXT0000.js'))
  expect(await reloadIfOutdated({ reload })).toBe('reloading')
  expect(reload).toHaveBeenCalledTimes(2)
})

test('once the tab has caught up, the next release reloads it again', async () => {
  loadTab(BEFORE)
  serve(shell(RELEASED))
  const reload = vi.fn()
  expect(await reloadIfOutdated({ reload })).toBe('reloading')
  loadTab(RELEASED)
  expect(await reloadIfOutdated({ reload })).toBe('current')
  // Back to the first release's files, as after a rollback.
  serve(shell(BEFORE))
  expect(await reloadIfOutdated({ reload })).toBe('reloading')
  expect(reload).toHaveBeenCalledTimes(2)
})

test('two checks at once reload once', async () => {
  loadTab(BEFORE)
  const answers: ((response: Response) => void)[] = []
  serve(() => new Promise<Response>((resolve) => answers.push(resolve)))
  const reload = vi.fn()
  const checks = [reloadIfOutdated({ reload }), reloadIfOutdated({ reload })]
  expect(answers).toHaveLength(2)
  answers.forEach((answer) => answer(new Response(shell(RELEASED))))
  // The second must not go on to start a login on a page that is leaving.
  expect(await Promise.all(checks)).toEqual(['reloading', 'reloading'])
  expect(reload).toHaveBeenCalledOnce()
})

test('after a reload has started every further check reports it', async () => {
  loadTab(BEFORE)
  const fetch = serve(shell(RELEASED))
  const reload = vi.fn()
  expect(await reloadIfOutdated({ reload })).toBe('reloading')
  expect(await reloadIfOutdated({ reload })).toBe('reloading')
  expect(reload).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledOnce()
})

test.each([
  ['a server error', () => serve('<h1>Bad Gateway</h1>', 502)],
  ['a page that is not the app', () => serve('<html><body>Captive portal</body></html>')],
  [
    'no connection',
    () =>
      serve(async () => {
        throw new TypeError('Failed to fetch')
      }),
  ],
])('%s leaves the tab alone', async (_name, respond) => {
  loadTab(BEFORE)
  respond()
  const reload = vi.fn()
  expect(await reloadIfOutdated({ reload })).toBe('unknown')
  expect(reload).not.toHaveBeenCalled()
  expect(window.sessionStorage.getItem('a04.reloaded_for')).toBeNull()
})

test('a server that does not answer in time does not hold the caller up', async () => {
  vi.useFakeTimers()
  loadTab(BEFORE)
  serve(
    (_input, { signal }) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
  )
  const reload = vi.fn()
  const pending = reloadIfOutdated({ reload, timeoutMs: 3000 })
  await vi.advanceTimersByTimeAsync(2999)
  let settled = false
  void pending.then(() => (settled = true))
  await Promise.resolve()
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(2)
  expect(await pending).toBe('unknown')
  expect(reload).not.toHaveBeenCalled()
})

test('a tab that cannot tell what it loaded never reloads', async () => {
  loadTab(null)
  const fetch = serve(shell(RELEASED))
  const reload = vi.fn()
  expect(await reloadIfOutdated({ reload })).toBe('unknown')
  expect(fetch).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
})

test('without session storage there is no reload, because nothing could stop a second one', async () => {
  loadTab(BEFORE)
  serve(shell(RELEASED))
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError')
  })
  const reload = vi.fn()
  expect(await reloadIfOutdated({ reload })).toBe('outdated')
  expect(reload).not.toHaveBeenCalled()
})

test('a check withdrawn while the server is still answering does nothing with the answer', async () => {
  loadTab(BEFORE)
  let answer: (response: Response) => void = () => {}
  let fetchSignal: AbortSignal | undefined
  serve((_input, { signal }) => {
    fetchSignal = signal
    return new Promise<Response>((resolve) => (answer = resolve))
  })
  const reload = vi.fn()
  const save = vi.fn()
  const question = new AbortController()
  const pending = reloadIfOutdated({ reload, beforeReload: save, signal: question.signal })

  // The sign-in went ahead, or the page was left.
  question.abort()
  expect(fetchSignal?.aborted).toBe(true)
  answer(new Response(shell(RELEASED)))

  expect(await pending).toBe('unknown')
  expect(save).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
  expect(window.sessionStorage.getItem('a04.reloaded_for')).toBeNull()
  // The tab is still free to reload for this release when somebody asks again.
  serve(shell(RELEASED))
  expect(await reloadIfOutdated({ reload })).toBe('reloading')
  expect(reload).toHaveBeenCalledOnce()
})

test('a check withdrawn before it starts does not ask the server', async () => {
  loadTab(BEFORE)
  const fetch = serve(shell(RELEASED))
  const question = new AbortController()
  question.abort()
  const reload = vi.fn()
  expect(await reloadIfOutdated({ reload, signal: question.signal })).toBe('unknown')
  expect(fetch).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
})

test('a withdrawn check on a current tab leaves an earlier note alone', async () => {
  loadTab(RELEASED)
  let answer: (response: Response) => void = () => {}
  serve(() => new Promise<Response>((resolve) => (answer = resolve)))
  window.sessionStorage.setItem('a04.reloaded_for', 'noted')
  const question = new AbortController()
  const pending = reloadIfOutdated({ signal: question.signal })
  question.abort()
  answer(new Response(shell(RELEASED)))
  expect(await pending).toBe('unknown')
  expect(window.sessionStorage.getItem('a04.reloaded_for')).toBe('noted')
})
