import type { Question } from './questionnaire'

// Read down each column before moving right. Follow-ups stay beside their
// trigger; the role on page one also controls the lesson count on page two.
const pageColumns = [
  [
    ['sex', 'age', 'participant_group', 'st_degree'],
    ['st_enrollment', 'st_subject', 'st_semester', 'st_schulform', 'dupl1_st_schulform'],
  ],
  [
    ['st_fach1', 'st_fach2', 'st_fach3', 'st_schulpraktikum', 'st_unterricht', 'teach_class'],
    ['teach_inf_ex', 'teach_inf_year', 'teach_prog_ex', 'teach_prog_year', 'java_ex', 'java_years'],
  ],
] as const

/** Presentation only: existing studies keep one response and their original IDs. */
export function demographicsLayout(questions: Question[]) {
  const byId = new Map(questions.map((question) => [question.id, question]))
  const expected = pageColumns.flat(2)
  // Researchers can replace the instrument. Keep their entire custom form in
  // ordinary flow rather than dropping or guessing where unfamiliar items go.
  if (questions.length !== expected.length || !expected.every((id) => byId.has(id))) return null

  return {
    questions: pageColumns.flatMap((columns) =>
      columns.flatMap((ids, index) =>
        ids.map((id) => ({ ...byId.get(id)!, layout_column: (index + 1) as 1 | 2 })),
      ),
    ),
    pages: pageColumns.map((columns, index) => ({
      titleKey:
        index === 0
          ? 'questionnaire.demographics_personal'
          : 'questionnaire.demographics_experience',
      questionIds: columns.flat(),
    })),
  }
}
