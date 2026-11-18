import { useLayoutEffect, useRef, type TableHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'

import './AdminTable.css'

/** Keep column labels with their values when a wide table becomes a list of rows. */
export default function AdminTable({
  children,
  className = 'table',
  ...props
}: TableHTMLAttributes<HTMLTableElement>) {
  const { t } = useTranslation()
  const ref = useRef<HTMLTableElement>(null)

  useLayoutEffect(() => {
    const table = ref.current
    if (!table) return
    const headers = Array.from(table.tHead?.rows[0]?.cells ?? [])
    table.dataset.columns = headers.length >= 7 ? 'wide' : 'regular'
    table.tHead?.setAttribute('role', 'rowgroup')
    for (const row of Array.from(table.rows)) {
      row.setAttribute('role', 'row')
      for (const cell of Array.from(row.cells)) {
        const heading = cell.tagName === 'TH'
        cell.setAttribute(
          'role',
          heading ? (cell.scope === 'row' ? 'rowheader' : 'columnheader') : 'cell',
        )
        if (row.parentElement === table.tHead) continue
        const label = headers[cell.cellIndex]?.textContent?.trim()
        cell.dataset.label = label || t('common.actions')
        cell.toggleAttribute('data-actions', !label)
      }
    }
    for (const body of Array.from(table.tBodies)) body.setAttribute('role', 'rowgroup')
  }, [children, t])

  return (
    <div className="admin-table-container">
      <table {...props} ref={ref} role="table" className={`${className} admin-table`}>
        {children}
      </table>
    </div>
  )
}
