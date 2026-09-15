import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi, type Study } from '../../api/admin'
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
      updateStudy: vi.fn(),
    },
  }
})

const getStudy = vi.mocked(adminApi.getStudy)
const listVideos = vi.mocked(adminApi.listVideos)
const uploadVideo = vi.mocked(adminApi.uploadVideo)

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
