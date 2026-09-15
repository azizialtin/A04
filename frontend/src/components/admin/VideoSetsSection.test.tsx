import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi, type AdminVideo, type VideoSet } from '../../api/admin'
import { ToastProvider } from '../Toast'
import VideoSetsSection from './VideoSetsSection'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      listVideoSets: vi.fn(),
      listVideos: vi.fn(),
      createVideoSet: vi.fn(),
      updateVideoSet: vi.fn(),
      deleteVideoSet: vi.fn(),
    },
  }
})

const listVideoSets = vi.mocked(adminApi.listVideoSets)
const listVideos = vi.mocked(adminApi.listVideos)
const createVideoSet = vi.mocked(adminApi.createVideoSet)
const updateVideoSet = vi.mocked(adminApi.updateVideoSet)

const VIDEOS: AdminVideo[] = [
  { id: 1, title: 'Vortest-Fall', phase_type: 'pre_test' },
  { id: 2, title: 'Schleife', phase_type: 'training' },
  { id: 3, title: 'Rekursion', phase_type: 'training' },
].map((v) => ({
  ...v,
  study_id: 9,
  task_description: '',
  info_text: '',
  student_task_text: '',
  time_limit_seconds: null,
  has_file: true,
  use_default_task: false,
  use_default_info: false,
}))

const SET_A: VideoSet = {
  id: 11,
  study_id: 9,
  name: 'A',
  participant_count: 2,
  items: [
    { slot_index: 0, video_id: 1, video_title: 'Vortest-Fall', phase_type: 'pre_test' },
    { slot_index: 1, video_id: 2, video_title: 'Schleife', phase_type: 'training' },
  ],
}

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <VideoSetsSection studyId={9} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  listVideos.mockReset().mockResolvedValue(VIDEOS)
  listVideoSets.mockReset().mockResolvedValue([SET_A])
  createVideoSet
    .mockReset()
    .mockResolvedValue({ ...SET_A, id: 12, name: 'B', items: [], participant_count: 0 })
  updateVideoSet.mockReset().mockImplementation(async (id, body) => ({
    ...SET_A,
    id,
    items: (body.items ?? []).map((it, i) => ({
      slot_index: i,
      video_id: it.video_id,
      video_title: VIDEOS.find((v) => v.id === it.video_id)?.title ?? '',
      phase_type: it.phase_type,
    })),
  }))
})

test('shows each set in order with how many participants it has been dealt to', async () => {
  view()
  const list = await screen.findByRole('list', { name: 'Videos in Set A' })
  const rows = within(list).getAllByRole('listitem')
  expect(rows[0]).toHaveTextContent('1. Vortest-Fall')
  expect(rows[1]).toHaveTextContent('2. Schleife')
  expect(screen.getByText('2 Teilnehmende')).toBeInTheDocument()
  // The second set is a click away, and it is suggested as B.
  expect(screen.getByPlaceholderText('Name (z. B. B)')).toBeInTheDocument()
})

test('a new video goes on the end and the order is saved with slot indexes', async () => {
  view()
  await screen.findByRole('list', { name: 'Videos in Set A' })

  fireEvent.change(screen.getByDisplayValue('Video wählen…'), { target: { value: '3' } })
  fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }))
  // Move the new one up above "Schleife".
  fireEvent.click(screen.getByRole('button', { name: 'Rekursion nach oben' }))
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))

  await waitFor(() => expect(updateVideoSet).toHaveBeenCalledTimes(1))
  expect(updateVideoSet).toHaveBeenCalledWith(11, {
    name: 'A',
    items: [
      { video_id: 1, slot_index: 0, phase_type: 'pre_test' },
      { video_id: 3, slot_index: 1, phase_type: 'training' },
      { video_id: 2, slot_index: 2, phase_type: 'training' },
    ],
  })
})

test('creating a set takes the suggested letter when no name is typed', async () => {
  view()
  await screen.findByRole('list', { name: 'Videos in Set A' })

  fireEvent.click(screen.getByRole('button', { name: 'Set anlegen' }))
  await waitFor(() => expect(createVideoSet).toHaveBeenCalledWith(9, { name: 'B', items: [] }))
})
