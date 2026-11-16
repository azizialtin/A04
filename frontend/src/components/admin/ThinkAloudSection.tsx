import { useState } from 'react'

import type { Study } from '../../api/admin'
import { useUpdateStudy } from '../../hooks/admin'
import { thinkAloudBlocks } from '../../lib/thinkAloud'

export default function ThinkAloudSection({ study }: { study: Study }) {
  const update = useUpdateStudy(study.id)
  const pilot = study.flow_version === 'pilot_20261116'
  const [mode, setMode] = useState<'block' | 'bundled'>(study.think_aloud_mode ?? 'block')
  const [size, setSize] = useState(String(study.think_aloud_batch_size))
  const [count, setCount] = useState(String(study.think_aloud_count ?? 3))
  const bundled = pilot && mode === 'bundled'
  const chosen = Number(bundled ? count : size)
  const valid = Number.isInteger(chosen) && chosen >= 1 && chosen <= 20
  const example = [
    'Vortestfall',
    ...Array.from({ length: 5 }, (_, i) => `Trainingsfall ${i + 1}`),
    'Nachtestfall',
  ]

  return (
    <section className="card form" style={{ marginTop: 16 }} aria-labelledby="think-aloud-settings">
      <h2 id="think-aloud-settings">Lautes Denken</h2>
      <p className="muted">
        {pilot
          ? 'Pilotablauf: Fragebogen-Phase, Video-Phase und Erörterungs-Phase.'
          : 'Diese Studie behält den bisherigen Ablauf. Neue Studien verwenden den Pilotablauf.'}
      </p>
      {pilot && (
        <fieldset className="form">
          <legend>Zeitpunkt der Seiten zum lauten Denken</legend>
          <label>
            <input
              type="radio"
              name="think-aloud-mode"
              checked={mode === 'block'}
              onChange={() => setMode('block')}
            />{' '}
            Blockweise während des Trainings
            <p className="muted small">
              Nach jedem Block folgen die Seiten zu den Fällen aus diesem Block. Im Vor- und
              Nachtest folgt die Seite direkt auf den jeweiligen Fall.
            </p>
          </label>
          <label>
            <input
              type="radio"
              name="think-aloud-mode"
              checked={mode === 'bundled'}
              onChange={() => setMode('bundled')}
            />{' '}
            Gebündelt nach dem Nachtest
            <p className="muted small">
              Nach dem Nachtestfall folgen die Seiten zu den letzten ausgewählten Fällen in der
              Reihenfolge ihrer Bearbeitung.
            </p>
          </label>
        </fieldset>
      )}
      {!pilot && (
        <p className="muted">
          Vor- und Nachtest werden unmittelbar nach dem jeweiligen Fall erörtert. Trainingsfälle
          können in Blöcken zusammengefasst werden.
        </p>
      )}
      <div className="form-row">
        <label className="label" htmlFor="think-aloud-size">
          {bundled
            ? 'Anzahl der letzten Fälle für „Lautes Denken“ (1–20)'
            : 'Fälle pro Block (1–20)'}
        </label>
        <input
          id="think-aloud-size"
          className="input"
          type="number"
          min={1}
          max={20}
          value={bundled ? count : size}
          onChange={(event) => (bundled ? setCount : setSize)(event.target.value)}
          style={{ maxWidth: 160 }}
        />
        {bundled && (
          <p className="muted small">
            Der Nachtestfall zählt mit. Bei weniger Fällen werden alle vorhandenen Fälle
            herangezogen.
          </p>
        )}
      </div>
      {valid && (
        <div aria-label="Beispiel für die Reihenfolge">
          <strong>
            Beispiel mit einem Vortestfall, fünf Trainingsfällen und einem Nachtestfall
          </strong>
          {bundled ? (
            <>
              <p>Nach allen Fällen und ihren Fragebögen folgen diese Seiten zum lauten Denken:</p>
              <ol>
                {example.slice(-chosen).map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ol>
              <p>Danach folgen die Abschlussfragebögen.</p>
            </>
          ) : (
            <p>
              {thinkAloudBlocks(5, chosen)
                .map(
                  (n) =>
                    `${n} ${n === 1 ? 'Trainingsfall' : 'Trainingsfälle'}, danach ${n}× lautes Denken`,
                )
                .join(' · ')}
            </p>
          )}
        </div>
      )}
      {!valid && <p className="error-text">Bitte eine ganze Zahl zwischen 1 und 20 eintragen.</p>}
      <div className="inline-form">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!valid || update.isPending}
          onClick={() =>
            update.mutate(
              pilot
                ? {
                    think_aloud_mode: mode,
                    ...(bundled
                      ? { think_aloud_count: chosen }
                      : { think_aloud_batch_size: chosen }),
                  }
                : { think_aloud_batch_size: chosen },
            )
          }
        >
          Speichern
        </button>
        {update.isSuccess && <span className="muted">Gespeichert.</span>}
        {update.isError && (
          <span className="error-text" role="alert">
            Konnte nicht gespeichert werden.
          </span>
        )}
      </div>
      <p className="muted small">
        Gilt für Teilnehmer, die sich danach zum ersten Mal anmelden. Bereits begonnene Durchläufe
        behalten ihren Ablauf.
      </p>
    </section>
  )
}
