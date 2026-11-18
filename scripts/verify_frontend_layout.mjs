/**
 * Isolated A04 responsive-layout audit; actual frontend, synthetic APIs, no study data.
 * Run from the repo: node --test scripts/verify_frontend_layout.mjs
 * Requires the frontend's installed Vite and Playwright browser dependencies.
 * A04_LAYOUT_WIDTHS=320,1470 limits viewport coverage; A04_LAYOUT_FILTER=msk
 * selects screen names. A04_LAYOUT_OUTPUT controls screenshots and report.json.
 * Every external HTTP request is blocked, and bridge messages are synthetic.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root =
  process.env.A04_LAYOUT_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "frontend");
const require = createRequire(path.join(frontend, "package.json"));
const browserName = process.env.A04_LAYOUT_BROWSER || "chromium";
assert.ok(["chromium", "webkit", "firefox"].includes(browserName), "Choose a supported browser");
const browserType = require("@playwright/test")[browserName];
const { createServer } = await import(
  pathToFileURL(path.join(frontend, "node_modules/vite/dist/node/index.js"))
    .href
);
const output = process.env.A04_LAYOUT_OUTPUT || "/tmp/a04-layout-evidence";
const origin = "http://127.0.0.1:5193",
  api = origin + "/__layout_api";
const widths = (process.env.A04_LAYOUT_WIDTHS || "320,390,768,1024,1470,1920")
  .split(",")
  .map(Number);
const source = JSON.parse(
  await readFile(
    path.join(root, "backend/app/data/pretest_nov2026.json"),
    "utf8",
  ),
);
const msk = JSON.parse(
  execFileSync(
    "python3",
    [
      "-c",
      `import ast,json,sys
source=ast.parse(open(sys.argv[1]).read())
print(json.dumps(next(ast.literal_eval(n.value) for n in source.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='PAGES' for t in n.targets))))`,
      path.join(
        root,
        "backend/alembic/versions/b3d8f2a6c4e1_msk_pre_test_pages.py",
      ),
    ],
    { encoding: "utf8" },
  ),
);
const stamp = "2026-11-17T09:00:00Z",
  id = "TEST-LAYOUT-123456";
const texts = {
  welcome_title: "",
  welcome_intro: "",
  welcome_steps: [],
  welcome_note: "",
  case_intro_title: "",
  case_intro_body: "",
  case_outro_title: "",
  case_outro_body: "",
  think_aloud_title: "",
  think_aloud_body: "",
};
const study = {
  id: 8,
  name: "Studie zur professionellen Wahrnehmung und Diagnosekompetenz",
  description: "Isolierte Browserprüfung",
  is_active: true,
  sosci_pretest_url: "",
  sosci_posttest_url: "",
  sosci_id_param: "id",
  texts,
  think_aloud_batch_size: 1,
  video_defaults: {
    time_limit_seconds: 420,
    task_description: "Beobachten Sie den Fall.",
    info_text: "Informationen zum Fall.",
  },
};
const video = {
  id: 7,
  study_id: 8,
  title: "Unterrichtsbeispiel mit ausführlicher Beschreibung",
  phase_type: "training",
  has_file: true,
  task_description: study.video_defaults.task_description,
  info_text: study.video_defaults.info_text,
  student_task_text: "Erklären Sie die Schleife.",
  time_limit_seconds: 420,
  use_default_task: false,
  use_default_info: false,
};
const person = {
  id,
  status: "registered",
  slot_count: 1,
  video_set_id: 1,
  video_set_name: "Videoset mit einer ausführlichen Beschreibung",
};
const stats = {
  generated_at: stamp,
  study,
  participants: {
    total: 1,
    registered: 1,
    active: 0,
    completed: 0,
    started: 0,
    completed_sessions: 0,
    completion_rate: 0,
    avg_progress: 0,
    avg_session_minutes: null,
    median_session_minutes: null,
    with_gaze: 0,
    with_screen: 0,
    with_calibration: 0,
    never_started: 1,
  },
  data: {
    notes: 0,
    note_chars: 0,
    diagnoses: 0,
    responses: 0,
    events: 0,
    gaze_recordings: 0,
    gaze_samples: 0,
    screens_stored: 0,
    screens_failed: 0,
    screen_bytes: 0,
    watch_seconds: 0,
  },
  cases: [],
  questionnaires: [],
  sections: [],
  calibration: { attempts: 0, participants: 0, by_status: {} },
  roster: [
    {
      ...person,
      created_at: stamp,
      cases: 1,
      assigned_sequence: true,
      video_set: person.video_set_name,
      step: 0,
      total_steps: 54,
      progress: 0,
      started_at: null,
      completed_at: null,
      session_minutes: null,
      first_event_at: null,
      last_event_at: null,
      events: 0,
      notes: 0,
      note_chars: 0,
      diagnoses: 0,
      responses: 0,
      watch_seconds: 0,
      gaze_recordings: 0,
      gaze_samples: 0,
      screens_stored: 0,
      screens_failed: 0,
      screen_bytes: 0,
      calibrations: 0,
      best_offset: null,
    },
  ],
  activity: [],
  events_by_type: [],
};
const questionnaire = {
  id: 1,
  study_id: 8,
  ...msk[5],
  placement: "pre_test",
  section: "MSK",
  order_index: 0,
  response_count: 0,
};
function adminResponse(endpoint) {
  if (endpoint === "/admin/studies") return [study];
  if (endpoint === "/admin/studies/8") return study;
  if (endpoint === "/admin/studies/8/videos") return [video];
  if (endpoint === "/admin/studies/8/participants") return [person];
  if (endpoint === "/admin/studies/8/video-sets")
    return [
      {
        id: 1,
        study_id: 8,
        name: person.video_set_name,
        participant_count: 1,
        items: [
          {
            slot_index: 0,
            video_id: 7,
            video_title: video.title,
            phase_type: "training",
          },
        ],
      },
    ];
  if (endpoint === "/admin/studies/8/questionnaires") return [questionnaire];
  if (endpoint === "/admin/studies/8/exports")
    return [
      "participants",
      "videos",
      "notes",
      "diagnoses",
      "responses",
      "sections",
      "events",
      "gaze",
      "gaze_recordings",
      "calibration",
    ].map((kind) => ({
      kind,
      filename: kind + ".csv",
      rows: 1,
      collected: kind !== "calibration",
    }));
  if (endpoint === "/admin/studies/8/stats") return stats;
  if (endpoint === "/admin/stats/overview")
    return {
      generated_at: stamp,
      totals: {
        ...stats.data,
        participants: 1,
        active: 0,
        registered: 1,
        completed: 0,
        completion_rate: 0,
        studies: 1,
        active_studies: 1,
        researchers: 1,
        videos: 1,
        videos_with_file: 1,
        finished: 0,
        calibrations: 0,
        calibrations_ok: 0,
        screen_recordings: 0,
      },
      studies: [],
      activity: [],
      events_by_type: [],
    };
  if (endpoint === "/admin/researchers")
    return [
      {
        id: "test-admin",
        email: "researcher-with-long-name@example.invalid",
        name: "Forschende Person mit langem Namen",
        is_active: true,
        created_at: stamp,
      },
    ];
  if (endpoint === "/admin/audit")
    return {
      items: [
        {
          id: 1,
          actor_email: "researcher-with-long-name@example.invalid",
          action: "study_questionnaire_updated",
          meta: { questionnaire: questionnaire.title, participant: id },
          created_at: stamp,
        },
      ],
    };
  if (endpoint === "/admin/gaze/recordings")
    return {
      items: [
        {
          participant_id: id,
          video_title: video.title,
          step_kind: "case_video",
          replay: { kind: "gaze", id: 1 },
          sample_count: 100,
          sampling_rate_hz: 120,
          screen: null,
          started_at: stamp,
        },
      ],
    };
  if (endpoint === "/admin/screen-recordings") return { items: [], total: 0 };
}
const base = { index: 0, completed: false };
const qstep = (data, extra = {}) => ({
  ...base,
  kind: "questionnaire",
  questionnaire_id: 1,
  placement: "pre_test",
  section: "Layout",
  video_id: null,
  page: 6,
  page_count: 7,
  ...data,
  ...extra,
});
const steps = [
  ["welcome", { ...base, kind: "welcome", texts }],
  [
    "section-intro",
    {
      ...base,
      kind: "section_intro",
      section_key: "ck_tasks",
      ...source.ck_intro,
      time_limit_seconds: 420,
    },
  ],
  ...msk.map((page, i) => [`msk-${i + 1}`, qstep(page)]),
  ...source.ck_tasks.map((task, i) => [
    `ck-${i + 1}`,
    qstep(
      {
        title: `CK-Aufgabe ${i + 1}`,
        description: "",
        questions: [task.question],
      },
      { section_key: "ck_tasks" },
    ),
  ]),
  ["pck", qstep(source.pck_example, { section_key: "pck" })],
  [
    "case-intro",
    {
      ...base,
      kind: "case_intro",
      video_id: 7,
      phase_type: "training",
      title: "Nächster Fall",
      body: "Bitte sehen Sie sich den nächsten Fall aufmerksam an und machen Sie Notizen.",
    },
  ],
  [
    "case-video",
    {
      ...base,
      kind: "case_video",
      video_id: 7,
      title: video.title,
      task_description: video.task_description,
      info_text: video.info_text,
      student_task_text: video.student_task_text,
      time_limit_seconds: 420,
    },
  ],
  [
    "diagnosis",
    {
      ...base,
      kind: "diagnosis",
      video_id: 7,
      title: "Ihre Diagnose",
      task_description: "Beschreiben Sie den Fehler.",
      section: "Sicherheit",
      questions: [
        {
          id: "confidence",
          type: "likert",
          text: "Wie sicher sind Sie sich?",
          scale_min: 1,
          scale_max: 10,
        },
      ],
    },
  ],
  [
    "case-outro",
    {
      ...base,
      kind: "case_outro",
      video_id: 7,
      phase_type: "training",
      questionnaire_id: 2,
      title: "Nach dem Fall",
      section: "Aufwand",
      instruction: "Bewerten Sie den Fall.",
      questions: [
        {
          id: "effort",
          type: "likert",
          text: "Wie schwierig war die Aufgabe?",
          scale_min: 1,
          scale_max: 9,
        },
      ],
    },
  ],
  [
    "think-aloud",
    {
      ...base,
      kind: "think_aloud",
      video_id: 7,
      title: video.title,
      phase_type: "training",
      case_number: 1,
      case_total: 3,
      batch_position: 1,
      batch_size: 1,
    },
  ],
  [
    "phase-transition",
    {
      ...base,
      kind: "phase_transition",
      phase_type: "training",
      phase_number: 2,
    },
  ],
  [
    "sosci",
    {
      ...base,
      kind: "sosci",
      variant: "pretest",
      url: "https://example.invalid/questionnaire",
      id_param: "id",
      participant_id: id,
    },
  ],
  ["calibration", { ...base, kind: "calibration" }],
  ["thanks", { ...base, kind: "thanks" }],
];
steps.push([
  "msk-screenshot",
  qstep({
    title: "MSK: Aufgabe 7",
    description:
      "Stellen Sie sich vor, Sie arbeiten an einer Programmieraufgabe und stoßen auf ein Problem. Sie entscheiden sich, im Internet (z. B. bei Stack Overflow oder GitHub), nach Lösungen zu suchen.\n\nWie beurteilen Sie die folgenden Vorgehensweisen?",
    questions: msk[6].questions
      .slice(0, 4)
      .map((question, index) => ({
        ...question,
        text: [
          "a) Sie durchsuchen die wichtigen Internetseiten, um einen Überblick zu gewinnen, welche für die Aufgabe hilfreich sind.",
          "b) Sie sammeln möglichst viele Informationen von den verschiedenen Seiten und überfliegen diese dann, um nichts Wichtiges zu übersehen.",
          "c) Sie überprüfen regelmäßig, ob die gefundenen Informationen zu Ihrer Vorstellung von der Lösung passen.",
          "d) Während Sie an der Lösung des Problems arbeiten, beschäftigen Sie sich auch mit interessanten Lösungsansätzen zu anderen Problemen, um Ihren Horizont zu erweitern.",
        ][index],
      })),
  }),
]);
const routes = [
  "/login",
  "/admin/login",
  "/admin/overview",
  "/admin/studies",
  "/admin/gaze",
  "/admin/audit",
  ...[
    "stats",
    "videos",
    "sets",
    "participants",
    "questionnaires",
    "export",
    "details",
  ].map((tab) => "/admin/studies/8?tab=" + tab),
];
async function geometry(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const rendered = (el) => {
      const rect = el.getBoundingClientRect(),
        css = getComputedStyle(el);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        css.visibility !== "hidden" &&
        css.display !== "none"
      );
    };
    const badControls = [
      ...document.querySelectorAll("button,input,select,textarea,a"),
    ]
      .filter(rendered)
      .flatMap((el) => {
        const box = el.getBoundingClientRect();
        return box.left < -0.5 || box.right > width + 0.5
          ? [
              {
                tag: el.tagName,
                label: (
                  el.textContent ||
                  el.getAttribute("aria-label") ||
                  el.name ||
                  ""
                )
                  .trim()
                  .slice(0, 80),
                left: box.left,
                right: box.right,
              },
            ]
          : [];
      });
    const scrollRegions = [...document.querySelectorAll("#root *")]
      .filter(rendered)
      .filter((el) => {
        if (el.matches("input,textarea,pre.code")) return false;
        const css = getComputedStyle(el);
        if (
          !["auto", "scroll", "hidden", "clip"].includes(css.overflowX) ||
          el.scrollWidth <= el.clientWidth + 2
        )
          return false;
        const box = el.getBoundingClientRect();
        return [...el.children].filter(rendered).some((child) => {
          const rect = child.getBoundingClientRect();
          return rect.left < box.left - 2 || rect.right > box.right + 2;
        });
      })
      .map((el) => ({
        tag: el.tagName,
        className: el.className,
        width: el.clientWidth,
        content: el.scrollWidth,
      }));
    return {
      width,
      content: document.documentElement.scrollWidth,
      badControls,
      scrollRegions,
    };
  });
}

test(
  "A04 frontend pages and response options fit narrow and desktop viewports",
  { timeout: 240000 },
  async () => {
    await mkdir(output, { recursive: true });
    const results = [],
      failures = [],
      errors = [],
      unexpected = [];
    const fixtureVideo = await readFile(
      path.join(frontend, "e2e/fixtures/stimulus.webm"),
    );
    let server,
      browser,
      currentStep = steps[0][1];
    try {
      server = await createServer({
        configFile: path.join(frontend, "vite.config.ts"),
        root: frontend,
        cacheDir: path.join(output, "vite-cache"),
        define: {
          "import.meta.env.VITE_API_BASE_URL": JSON.stringify(api),
          "import.meta.env.VITE_TOBII_WS_URL": JSON.stringify(
            "ws://127.0.0.1:8766",
          ),
        },
        server: { host: "127.0.0.1", port: 5193, strictPort: true, hmr: false },
      });
      await server.listen();
      browser = await browserType.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: widths[0], height: 900 },
      });
      await context.routeWebSocket("ws://127.0.0.1:8766", (ws) =>
        ws.send(
          JSON.stringify({
            type: "status",
            connected: false,
            frequency: 120,
            screen_recording: false,
          }),
        ),
      );
      await context.addInitScript(() => {
        if (
          location.pathname === "/login" ||
          location.pathname === "/admin/login"
        ) {
          localStorage.removeItem("a04_auth");
          return;
        }
        const role = location.pathname.startsWith("/admin")
          ? "admin"
          : "participant";
        const token =
          "e30." +
          btoa(
            JSON.stringify({
              sub: "TEST-LAYOUT-123456",
              role,
              exp: 4_000_000_000,
            }),
          ) +
          ".test";
        localStorage.setItem("a04_auth", JSON.stringify({ token }));
        localStorage.setItem("i18nextLng", "de");
      });
      await context.route("**/*", async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        if (url.href.startsWith(api)) {
          const endpoint = url.pathname.replace("/__layout_api", ""),
            value = adminResponse(endpoint);
          if (value !== undefined && req.method() === "GET")
            return route.fulfill({ json: value });
          if (endpoint === "/participant/me")
            return route.fulfill({
              json: { id, status: "active", study_name: study.name },
            });
          if (endpoint === "/participant/session")
            return route.fulfill({
              json: {
                status: "active",
                current_step_index: 0,
                total_steps: 1,
                steps: [currentStep],
              },
            });
          if (endpoint === "/participant/events")
            return route.fulfill({ json: { id: 1 } });
          if (endpoint === "/participant/session/questionnaire-visit")
            return route.fulfill({
              json: {
                visit_id: req.postDataJSON().visit_id,
                section_timing:
                  currentStep.section_key === "ck_tasks"
                    ? {
                        section_key: "ck_tasks",
                        deadline_ms: Date.now() + 420000,
                        server_now_ms: Date.now(),
                        finished: false,
                        started_client_ts: Date.now(),
                        ended_client_ts: null,
                      }
                    : null,
              },
            });
          if (endpoint.endsWith("/notes")) return route.fulfill({ json: [] });
          if (endpoint.endsWith("/url"))
            return route.fulfill({
              json: { signed_url: api + "/stimulus.webm" },
            });
          if (endpoint === "/stimulus.webm")
            return route.fulfill({
              contentType: "video/webm",
              body: fixtureVideo,
            });
          if (endpoint.endsWith("/replay"))
            return route.fulfill({
              json: {
                video_url: api + "/stimulus.webm",
                source: "clip",
                sampling_rate_hz: 120,
                points: [],
                plotted_points: 0,
                invalid_samples: 0,
                unmapped_samples: 0,
                offscreen_samples: 0,
                has_geometry: false,
                epoch_ms: null,
                duration_ms: 2000,
                recorder: null,
              },
            });
          unexpected.push({ method: req.method(), endpoint });
          return route.fulfill({
            status: 500,
            json: { detail: "Unstubbed isolated test route" },
          });
        }
        if (url.origin !== origin) {
          unexpected.push({ url: url.href });
          return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) =>
        errors.push({ route: page.url(), error: error.message }),
      );
      const check = async (name) => {
        await page.waitForLoadState("networkidle");
        await page.evaluate(() => document.fonts.ready);
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          const measured = await geometry(page),
            entry = { name, ...measured };
          results.push(entry);
          if (name.startsWith("msk-")) {
            assert.equal(
              await page.locator("input[type=radio]").count(),
              currentStep.questions.reduce((n, q) => n + q.options.length, 0),
              "Every answer option is rendered",
            );
            for (const question of currentStep.questions) {
              const radio = page
                .locator(`input[type=radio][name="${question.id}"]`)
                .last();
              await radio.check();
              assert.equal(
                await radio.isChecked(),
                true,
                `${name} at ${width}px: last option remains selectable`,
              );
            }
            const warning = await page
                .locator(".gaze-health-stack")
                .boundingBox(),
              form = await page.locator(".panel--form").boundingBox();
            if (warning && form)
              assert.ok(
                warning.y + warning.height <= form.y + 1,
                "Tracker warning does not cover the questionnaire",
              );
          }
          if (
            measured.content > width + 1 ||
            measured.badControls.length ||
            measured.scrollRegions.length
          ) {
            failures.push(entry);
            console.log("LAYOUT", JSON.stringify(entry));
          }
          if ([320, 1470].includes(width))
            await page.screenshot({
              path: path.join(
                output,
                name.replace(/[^a-zA-Z0-9_-]/g, "_") + "-" + width + ".png",
              ),
              fullPage: true,
            });
        }
      };
      for (const route of routes) {
        if (
          process.env.A04_LAYOUT_FILTER &&
          !route.includes(process.env.A04_LAYOUT_FILTER)
        )
          continue;
        await page.goto(origin + route);
        await check(route);
      }
      for (const [name, step] of steps) {
        if (
          process.env.A04_LAYOUT_FILTER &&
          !name.includes(process.env.A04_LAYOUT_FILTER)
        )
          continue;
        currentStep = step;
        await page.goto(origin + "/session");
        await check(name);
        if (name.startsWith("msk-")) {
          assert.equal(
            await page.locator("input[type=radio]").count(),
            step.questions.reduce((n, q) => n + q.options.length, 0),
            "Every answer option is rendered",
          );
          for (const question of step.questions) {
            const radio = page
              .locator(`input[type=radio][name="${question.id}"]`)
              .last();
            await radio.check();
            assert.equal(
              await radio.isChecked(),
              true,
              `${name}: final option remains selectable`,
            );
          }
          const before = await page
            .locator("input[type=radio]:checked")
            .count();
          await page.setViewportSize({ width: widths[0], height: 900 });
          assert.equal(
            await page.locator("input[type=radio]:checked").count(),
            before,
            "Answers survive layout changes",
          );
        }
      }
      await writeFile(
        path.join(output, "report.json"),
        JSON.stringify(
          {
            passed: !failures.length && !errors.length && !unexpected.length,
            results,
            failures,
            errors,
            unexpected,
          },
          null,
          2,
        ),
      );
      assert.deepEqual(errors, [], "Browser runtime errors");
      assert.deepEqual(
        unexpected,
        [],
        "Unstubbed requests must be investigated",
      );
      assert.deepEqual(failures, [], "Horizontal overflow or clipped controls");
    } finally {
      await browser?.close();
      await server?.close();
    }
  },
);
