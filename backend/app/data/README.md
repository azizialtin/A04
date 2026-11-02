# Versioned pre-test sources

`pretest_nov2026.json` is the current participant-facing content, from
`A04_DataCollection - [TODO] Pre-Test Inside Tool (1).csv`, supplied on
2 November 2026. It preserves all thirteen CK exercises in CSV row order, now
named `ck_pre_01` through `ck_pre_13`. Only the CK IDs changed in the updated
CSV: the exercises, code, blank lines, file boundaries, prompts and order did
not change. Its source key is `a04-pretest-2026-11-02`.

`pretest_oct2026.json` remains unchanged as the historical source for
`a04-pretest-2026-10-27`. That version used the user-approved correction for
duplicate CSV IDs: retain the first `ck_pre_12`/`ck_pre_13` and name the later
duplicates `ck_pre_08`/`ck_pre_10`. Do not reinterpret an existing response's ID
using the new manifest. Each task's `source_ref` identifies its source version,
CSV row and original variable. The current manifest's `ck_id_mapping.crosswalk`
records the corresponding exercise across versions:

| CSV row | October study ID | November study ID |
| --- | --- | --- |
| 14 | `ck_pre_01` | `ck_pre_01` |
| 15 | `ck_pre_12` | `ck_pre_02` |
| 16 | `ck_pre_13` | `ck_pre_03` |
| 17 | `ck_pre_07` | `ck_pre_04` |
| 18 | `ck_pre_02` | `ck_pre_05` |
| 19 | `ck_pre_03` | `ck_pre_06` |
| 20 | `ck_pre_04` | `ck_pre_07` |
| 21 | `ck_pre_05` | `ck_pre_08` |
| 22 | `ck_pre_06` | `ck_pre_09` |
| 23 | `ck_pre_09` | `ck_pre_10` |
| 24 | `ck_pre_11` | `ck_pre_11` |
| 25 | `ck_pre_08` | `ck_pre_12` |
| 26 | `ck_pre_10` | `ck_pre_13` |

Neither manifest contains expected error lines, solutions or scoring rationale.
The shared PCK example is under `pck_example`; its supplied code, wording and
three subquestions remain together on one page. The new CSV still supplies only
`pck_pre_01a`, `pck_pre_01b` and `pck_pre_01c`; it adds no further PCK questions,
final introduction text or AOI definitions.

New studies receive demographics, the two existing CK self-assessment pages,
the supplied CK introduction and thirteen tasks, an editable PCK introduction
and the shared PCK example, and the seven existing MSK pages. The initial PCK
intro reuses the generic “Bitte beantworten Sie die folgenden Fragen.” text.
The CK tasks have a five-entry limit. Existing self-assessment
IDs and scales are retained. PCK author-review notes about the closing brace and
the referenced pupil explanation are kept as source metadata; they do not block
loading the supplied example and are not shown as participant instructions.
No missing text, code correction or additional PCK item is invented.

Existing studies are unchanged. The admin's standard-battery seed action skips
an entire placement that already contains a page, so it is not an instrument
upgrade button. For an explicitly selected unstarted study, put a populated PCK
page after the existing CK self-assessment. The guarded CK importer needs that
first PCK page's questionnaire ID. From `backend/`, preview with:

```sh
python -m app.cli import-ck-pretest --study-id STUDY_ID \
  --pck-questionnaire-id PCK_PAGE_ID
```

The default is a dry run. Review its row-to-variable list, then run the same
command with `--apply` to insert the thirteen CK pages and their introduction
before the selected PCK page. Existing pages retain their relative order and
content. The import marks the CK and selected PCK sections for supervised timing
and navigation; it does not replace the selected PCK content or rename existing
self-assessment variables. It uses the November mapping by default. An optional
`--mapping /path/to/row-ids.json` overrides it with a complete, unique mapping
whose keys are the CSV row numbers `14` through `26` as strings.

The command rejects studies with sessions or responses, conflicting variable IDs,
mixed source versions, and partial/edited previous imports. Repeating an unchanged
import does nothing. An intact October import is verified against the October
manifest and reported as an unchanged historical instrument; it is never silently
renamed to the November IDs. An explicit mapping that would rename an existing
import is also refused. Use a new study for the corrected instrument.
The command never overwrites researcher edits or truncates historical answers.
Started studies require a separate new study; neither the schema migration nor
this command rewrites their questionnaire pages or saved session pointers.
