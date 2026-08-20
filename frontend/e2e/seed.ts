// Builds a study to walk through, over the same API the researchers use — so
// the seeding itself exercises the admin surface rather than reaching into the
// database behind it.

const API = process.env.E2E_API_URL ?? 'http://localhost:8031'

// Enough of an ISO base media header to pass the upload's container check.
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
  Buffer.alloc(64),
])

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      ...(rest.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...rest.headers,
    },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

export interface Seeded {
  participantId: string
  studyId: number
}

/**
 * A study with two cases and one participant.
 *
 * The study arrives with the standard batteries already on it, so the run walks
 * the real diagnosis and outro questions. Only the pre-test block is swapped for
 * a single short page — this test is about the flow joining up, not about
 * filling in twenty demographic fields.
 */
export async function seedStudy(adminEmail: string, adminPassword: string): Promise<Seeded> {
  const { access_token: token } = await api('/auth/admin/login', {
    method: 'POST',
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  })

  const stamp = Date.now()
  const study = await api('/admin/studies', {
    method: 'POST',
    token,
    body: JSON.stringify({
      name: `E2E ${stamp}`,
      sosci_pretest_url: 'https://sosci.example/pre',
      sosci_posttest_url: 'https://sosci.example/post',
    }),
  })

  for (const [i, phase] of ['pre_test', 'post_test'].entries()) {
    const form = new FormData()
    form.set('title', `Fall ${i + 1}`)
    form.set('phase_type', phase)
    form.set('task_description', `Diagnostizieren Sie Fall ${i + 1}`)
    form.set('info_text', 'Hintergrund zum Fall')
    form.set('student_task_text', 'Die Aufgabe der Schüler:innen')
    form.set('file', new Blob([MP4], { type: 'video/mp4' }), 'case.mp4')
    await api(`/admin/studies/${study.id}/videos`, { method: 'POST', token, body: form })
  }

  const seeded: { id: number; placement: string }[] = await api(
    `/admin/studies/${study.id}/questionnaires`,
    { token },
  )
  for (const q of seeded.filter((q) => q.placement === 'pre_test')) {
    await api(`/admin/questionnaires/${q.id}?force=true`, { method: 'DELETE', token })
  }
  await api(`/admin/studies/${study.id}/questionnaires`, {
    method: 'POST',
    token,
    body: JSON.stringify({
      placement: 'pre_test',
      title: 'Angaben zur Person',
      order_index: 0,
      questions: [{ id: 'age', type: 'number', text: 'Alter' }],
    }),
  })

  const participantId = `E2E-${stamp}`
  await api(`/admin/studies/${study.id}/participants`, {
    method: 'POST',
    token,
    body: JSON.stringify({ ids: [participantId] }),
  })

  return { participantId, studyId: study.id }
}
