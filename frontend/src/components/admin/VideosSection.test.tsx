import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi, type AdminVideo, type Study } from '../../api/admin'
import { ToastProvider } from '../Toast'
import VideosSection from './VideosSection'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      getStudy: vi.fn(),
      listVideos: vi.fn(),
      uploadVideo: vi.fn(),
      updateVideo: vi.fn(),
      updateStudy: vi.fn(),
    },
  }
})

const getStudy = vi.mocked(adminApi.getStudy)
const listVideos = vi.mocked(adminApi.listVideos)
const uploadVideo = vi.mocked(adminApi.uploadVideo)
const updateVideo = vi.mocked(adminApi.updateVideo)

const VIDEO: AdminVideo = {
  id: 17,
  study_id: 9,
  title: 'Fall 1',
  phase_type: 'training',
  task_description: 'Eigene Aufgabe',
  info_text: 'Eigener Hinweis',
  student_task_text: '```\nclass Test {\n\n  int x = 1;\n}\n```',
  time_limit_seconds: 420,
  has_file: true,
  use_default_task: false,
  use_default_info: false,
}

const STUDY: Study = {
  id: 9,
  name: 'S',
  description: '',
  sosci_pretest_url: '',
  sosci_posttest_url: '',
  sosci_id_param: 'id',
  is_active: true,
  texts: {
    welcome_title: '',
    welcome_intro: '',
    welcome_steps: [],
    welcome_note: '',
    case_intro_title: '',
    case_intro_body: '',
    case_outro_title: '',
    case_outro_body: '',
    think_aloud_title: '',
    think_aloud_body: '',
  },
  video_defaults: {
    time_limit_seconds: 420,
    task_description: 'Finden Sie den Fehler.',
    info_text: '',
  },
  think_aloud_batch_size: 1,
}

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <VideosSection studyId={9} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getStudy.mockReset().mockResolvedValue(STUDY)
  listVideos.mockReset().mockResolvedValue([])
  uploadVideo.mockReset().mockResolvedValue({
    id: 1,
    study_id: 9,
    title: 'Fall 1',
    phase_type: 'training',
    task_description: '',
    info_text: '',
    student_task_text: '',
    time_limit_seconds: 420,
    has_file: true,
    use_default_task: true,
    use_default_info: false,
  })
  updateVideo.mockReset().mockResolvedValue(VIDEO)
})

test("a new video starts from the study's defaults", async () => {
  view()

  // The timer is filled in, the task follows the default, the info text does
  // not because the study has none.
  await waitFor(() => expect(screen.getByLabelText(/Zeitlimit/)).toHaveValue(420))
  const [taskBox, infoBox] = screen.getAllByRole('checkbox', {
    name: /Standardtext der Studie verwenden/,
  })
  expect(taskBox).toBeChecked()
  expect(infoBox).not.toBeChecked()
  // And what following the default means is shown, read-only.
  expect(screen.getByLabelText('Aufgabe (Task)')).toHaveValue('Finden Sie den Fehler.')
  expect(screen.getByLabelText('Aufgabe (Task)')).toHaveAttribute('readonly')
})

test('the upload says which texts follow the default', async () => {
  view()
  await waitFor(() => expect(screen.getByLabelText(/Zeitlimit/)).toHaveValue(420))

  fireEvent.change(screen.getByLabelText('Titel'), { target: { value: 'Fall 1' } })
  fireEvent.change(screen.getByLabelText('Info-Text'), { target: { value: 'Eigener Hinweis' } })
  const file = new File(['x'], 'case.mp4', { type: 'video/mp4' })
  fireEvent.change(screen.getByLabelText('Videodatei'), { target: { files: [file] } })
  fireEvent.click(screen.getByRole('button', { name: 'Hochladen' }))

  await waitFor(() => expect(uploadVideo).toHaveBeenCalledTimes(1))
  expect(uploadVideo.mock.calls[0][1]).toMatchObject({
    title: 'Fall 1',
    time_limit_seconds: 420,
    use_default_task: true,
    task_description: '',
    use_default_info: false,
    info_text: 'Eigener Hinweis',
  })
})

async function openEditor(video = VIDEO) {
  listVideos.mockResolvedValue([video])
  view()
  fireEvent.click(await screen.findByRole('button', { name: `Video „${video.title}“ bearbeiten` }))
  return within(screen.getByRole('dialog', { name: 'Video bearbeiten' }))
}

test('edits existing metadata without media or sequence changes and refreshes the list', async () => {
  const editor = await openEditor()
  expect(editor.getByLabelText('Titel')).toHaveValue('Fall 1')
  expect(editor.getByLabelText('Schüler-Aufgabe')).toHaveValue(VIDEO.student_task_text)
  expect(editor.queryByLabelText('Phase')).not.toBeInTheDocument()
  expect(editor.queryByLabelText('Videodatei')).not.toBeInTheDocument()

  fireEvent.change(editor.getByLabelText('Titel'), { target: { value: '  Korrigierter Fall  ' } })
  fireEvent.change(editor.getByLabelText('Aufgabe (Task)'), {
    target: { value: 'Bitte Notizen machen.' },
  })
  fireEvent.change(editor.getByLabelText('Info-Text'), {
    target: { value: 'Unterrichtsentscheidungen' },
  })
  fireEvent.change(editor.getByLabelText('Schüler-Aufgabe'), {
    target: { value: `${VIDEO.student_task_text}\nNeue Anweisung.` },
  })
  fireEvent.change(editor.getByLabelText(/Zeitlimit/), { target: { value: '' } })
  const body = {
    title: 'Korrigierter Fall',
    task_description: 'Bitte Notizen machen.',
    info_text: 'Unterrichtsentscheidungen',
    student_task_text: `${VIDEO.student_task_text}\nNeue Anweisung.`,
    time_limit_seconds: null,
  }
  listVideos.mockResolvedValue([{ ...VIDEO, ...body }])
  fireEvent.click(editor.getByRole('button', { name: 'Speichern' }))

  await waitFor(() => expect(updateVideo).toHaveBeenCalledWith(17, body))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(
    await screen.findByRole('button', { name: 'Video „Korrigierter Fall“ bearbeiten' }),
  ).toBeInTheDocument()
  expect(uploadVideo).not.toHaveBeenCalled()
})

test('switching defaults previews study text and preserves the hidden override', async () => {
  const editor = await openEditor()
  const [taskChoice, infoChoice] = editor.getAllByRole('checkbox', { name: /Standardtext/ })
  fireEvent.click(taskChoice)
  expect(editor.getByLabelText('Aufgabe (Task)')).toHaveValue(STUDY.video_defaults.task_description)
  expect(editor.getByLabelText('Aufgabe (Task)')).toHaveAttribute('readonly')
  fireEvent.click(taskChoice)
  expect(editor.getByLabelText('Aufgabe (Task)')).toHaveValue(VIDEO.task_description)
  fireEvent.click(taskChoice)
  fireEvent.click(infoChoice)
  expect(editor.getByLabelText('Info-Text')).toHaveValue('')
  expect(editor.getByText(/für die Studie ist noch keiner hinterlegt/)).toBeInTheDocument()
  fireEvent.click(editor.getByRole('button', { name: 'Speichern' }))
  await waitFor(() =>
    expect(updateVideo).toHaveBeenCalledWith(17, {
      use_default_task: true,
      use_default_info: true,
    }),
  )
})

test('cancel discards changes and reopening restores stored values', async () => {
  const editor = await openEditor()
  fireEvent.change(editor.getByLabelText('Titel'), { target: { value: 'Nicht speichern' } })
  fireEvent.click(editor.getByRole('button', { name: 'Abbrechen' }))
  expect(updateVideo).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Video „Fall 1“ bearbeiten' }))
  expect(within(screen.getByRole('dialog')).getByLabelText('Titel')).toHaveValue(VIDEO.title)
})

test('invalid title and timer focus the field without saving', async () => {
  const editor = await openEditor()
  fireEvent.change(editor.getByLabelText('Titel'), { target: { value: '  ' } })
  fireEvent.click(editor.getByRole('button', { name: 'Speichern' }))
  expect(editor.getByLabelText('Titel')).toHaveFocus()
  expect(editor.getByRole('alert')).toHaveTextContent('Titel mit 1 bis 255 Zeichen')
  fireEvent.change(editor.getByLabelText('Titel'), { target: { value: VIDEO.title } })
  for (const value of ['-1', '1.5']) {
    fireEvent.change(editor.getByLabelText(/Zeitlimit/), { target: { value } })
    fireEvent.click(editor.getByRole('button', { name: 'Speichern' }))
    expect(editor.getByLabelText(/Zeitlimit/)).toHaveFocus()
    expect(editor.getByRole('alert')).toHaveTextContent('ganze Sekunden')
  }
  fireEvent.change(editor.getByLabelText(/Zeitlimit/), { target: { value: '2147483648' } })
  fireEvent.click(editor.getByRole('button', { name: 'Speichern' }))
  expect(editor.getByRole('alert')).toHaveTextContent('Zeitlimit ist zu groß')
  expect(updateVideo).not.toHaveBeenCalled()
})

test('pending save prevents duplicates and dismissal, then failure keeps drafts for retry', async () => {
  let rejectSave: (error: Error) => void = () => {}
  updateVideo.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectSave = reject
    }),
  )
  const editor = await openEditor()
  fireEvent.change(editor.getByLabelText('Titel'), { target: { value: 'Korrektur' } })
  fireEvent.click(editor.getByRole('button', { name: 'Speichern' }))
  await waitFor(() =>
    expect(editor.getByRole('button', { name: 'Wird gespeichert…' })).toBeDisabled(),
  )
  expect(editor.getByLabelText('Titel')).toBeDisabled()
  expect(editor.getByRole('button', { name: 'Schließen' })).toBeDisabled()
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(screen.getByRole('dialog'))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(updateVideo).toHaveBeenCalledTimes(1)

  rejectSave(new Error('offline'))
  expect(await editor.findByRole('alert')).toHaveTextContent('Ihre Eingaben bleiben erhalten')
  expect(editor.getByLabelText('Titel')).toHaveValue('Korrektur')
  fireEvent.click(editor.getByRole('button', { name: 'Speichern' }))
  await waitFor(() => expect(updateVideo).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})
