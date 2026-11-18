import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'

import AdminTable from './AdminTable'

function RecordRow({ name }: { name: string }) {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>Bereit</td>
      <td>
        <button type="button">Öffnen</button>
      </td>
    </tr>
  )
}

function records(name: string, label = 'Name') {
  return (
    <AdminTable aria-label="Aufzeichnungen">
      <thead>
        <tr>
          <th>{label}</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <RecordRow name={name} />
      </tbody>
    </AdminTable>
  )
}

test('responsive rows keep their column labels, row headers and actions after a data refresh', () => {
  const { rerender } = render(records('Erster Fall'))
  const table = screen.getByRole('table', { name: 'Aufzeichnungen' })
  expect(within(table).getAllByRole('columnheader')).toHaveLength(3)
  expect(within(table).getByRole('rowheader', { name: 'Erster Fall' })).toHaveAttribute(
    'data-label',
    'Name',
  )
  expect(within(table).getByRole('cell', { name: 'Bereit' })).toHaveAttribute(
    'data-label',
    'Status',
  )
  const actions = within(table).getByRole('button', { name: 'Öffnen' }).closest('td')
  expect(actions).toHaveAttribute('data-actions')
  expect(actions?.getAttribute('data-label')).toBeTruthy()

  rerender(records('Zweiter Fall', 'Aufgabe'))
  expect(within(table).getByRole('rowheader', { name: 'Zweiter Fall' })).toHaveAttribute(
    'data-label',
    'Aufgabe',
  )
  expect(within(table).getAllByRole('row')).toHaveLength(2)
})
