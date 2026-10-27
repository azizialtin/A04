# October 2026 pre-test source

`pretest_oct2026.json` contains participant-facing content from the supplied CSV.
It preserves all thirteen CK rows in source order and retains their original
source variables as provenance. It contains no expected error lines, solutions
or scoring rationale. The shared PCK example is under `pck_example`; its supplied
code, wording and three subquestions remain together on one page.

The user approved the CK mapping on 27 October 2026: retain the first
`ck_pre_12` and `ck_pre_13` (CSV rows 15 and 16), and assign the later duplicates
on rows 25 and 26 to `ck_pre_08` and `ck_pre_10`. The complete mapping is stored
in `ck_id_mapping.rows`. The task order remains
`01, 12, 13, 07, 02, 03, 04, 05, 06, 09, 11, 08, 10`; IDs never determine order.
Each imported question also retains its CSV row and original variable in
`source_ref` for analysis.

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
self-assessment variables. It uses the approved mapping by default. An optional
`--mapping /path/to/row-ids.json` overrides it with a complete, unique mapping
whose keys are the CSV row numbers `14` through `26` as strings.

The command rejects studies with sessions or responses, conflicting variable IDs,
and partial/edited previous imports. Repeating an unchanged import does nothing.
It never overwrites researcher edits or truncates historical answers.
Started studies require a separate new study; neither the schema migration nor
this command rewrites their questionnaire pages or saved session pointers.
