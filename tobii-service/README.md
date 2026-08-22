# Tobii bridge

Streams gaze from a Tobii Pro tracker to the A04 frontend over WebSocket, and
records the screen while a case clip is on. Runs on the lab machine next to the
browser.

## Mock (any machine, no hardware)

```bash
pip install -r requirements.txt
python tobii_bridge.py --mock
```

Streams synthetic gaze *and* records a test pattern instead of the real screen,
so the whole path — capture, clock anchor, upload, think-aloud replay — can be
developed and demoed without a tracker and without granting screen-recording
permission.

## Real tracker (lab machine)

The Tobii Pro SDK (`tobii_research`) is **Python 3.10 only**. Create a 3.10
virtual environment, install `tobii_research` from the vendor package, then:

```bash
python tobii_bridge.py            # defaults to ws://0.0.0.0:8765
```

Point the frontend at a non-default address with `VITE_TOBII_WS_URL`.

## Screen recording

The think-aloud replays a recording of the whole display, not the clip on its
own: the participant's cursor, the notes box, the timer and every dialog they
opened are part of what they are asked to narrate, and the gaze dot is drawn on
top of it.

It runs here rather than in the browser for two reasons. Chrome does not draw
the cursor into a captured *tab*, only a captured screen. And the recording has
to share the clock that stamps the gaze samples — which is this machine's, not
the server's.

Needs **ffmpeg on PATH**. Without it the bridge reports
`screen_recording: false` in its status message, the browser never asks, and the
think-aloud falls back to the clip. Nothing blocks the participant either way.

```bash
python tobii_bridge.py --no-screen-recording        # gaze only
python tobii_bridge.py --screen-fps 30 --screen-crf 28 --screen-max-height 1080
python tobii_bridge.py --screen-device "2:none"     # pick another display
python tobii_bridge.py --mock --screen-source display  # mock gaze, real screen
```

`--screen-source` decides what gets captured: `display`, `test-pattern`, or
`auto` (the default — the display, or the test pattern under `--mock`). Pair
`--mock` with `display` when developing on a machine with no tracker: the test
pattern shows none of the cursor and pause behaviour the replay exists for.

`--screen-device` is a gdigrab source on Windows (default `desktop`), an
avfoundation index on macOS, an X11 display on Linux (default `:0.0`). The
capture must be the same display the tracker was calibrated against, or gaze
will land on the wrong pixels.

**macOS has no default device**, because there is no index that is right on
every Mac: avfoundation numbers cameras and screens in one list, so a machine
with a Continuity camera paired puts the display at 4 rather than 1. The bridge
probes for the `Capture screen` entry at start and refuses to record if it
cannot find one — a wrong index records a camera pointed at the participant, and
that capture *succeeds*, so nothing downstream would catch it. Pass
`--screen-device` if the probe cannot help. macOS also needs Screen Recording
permission for whichever terminal runs the bridge.

**The clock.** ffmpeg reports how far into the output it is; the wall time of
video position zero is `now - out_time`. Encoding only ever runs behind the
capture, so the bridge keeps the *smallest* such reading it sees and sends that
as `epoch_ms`. The replay is then `sample_ts - epoch_ms` and nothing else.

**Stopping.** A capture is ended by writing `q` to ffmpeg's stdin so it can
flush and move the moov atom to the front. Killing it instead leaves an mp4
nothing can play, so the bridge waits up to 30 s and reports a failure rather
than pretending. If the browser navigates away without saying stop, the bridge
notices the socket close and stops the capture itself.

**If an upload fails** the file is kept in `unsent-recordings/` (override with
`--screen-keep-dir`) and the backend is told the capture failed, with the path
in the message — so it shows up in the admin's gaze list rather than going
quiet. A session cannot be repeated, so nothing here throws a recording away.

## Protocol

- On connect the bridge sends
  `{"type":"status","connected":bool,"frequency":hz,"display_w_mm":…,"display_h_mm":…,
  "screen_recording":bool}`.
  The physical screen size is what lets the app report calibration accuracy in
  degrees rather than as a fraction of the screen.
- The client sends `{"type":"start_gaze"}` / `{"type":"stop_gaze"}`.
- Each sample: `{"type":"gaze","ts":<ms>,"lx","ly","rx","ry":0..1|null,"lv","rv":bool,
  "dz":<eye distance mm|null>,"device_ts":<µs>}` (coordinates are null on blink
  / track-loss). Coordinates are fractions of the **whole display**, not of the
  video — the backend maps them onto the clip using the geometry the frontend
  records alongside each gaze recording.

### Calibration

Driven from the browser, one target at a time, over the same socket:

```
-> {"type":"calibrate_start"}                    <- {"type":"calibration_started","ok":true}
-> {"type":"calibrate_point","x":0.1,"y":0.1}    <- {"type":"calibration_point_result","ok":true,…}
-> {"type":"calibrate_compute"}                  <- {"type":"calibration_result","ok":true}
-> {"type":"calibrate_abort"}                    <- {"type":"calibration_aborted"}
```

Target coordinates are display fractions. `--mock` accepts the whole exchange
and reports success, so the calibration screen can be developed without
hardware.

### Screen recording

```
-> {"type":"start_screen_recording","upload_url":…,"session_url":…,
    "complete_url":…,"failed_url":…,"token":…}
<- {"type":"screen_recording_started","ok":true,"error":null}
-> {"type":"stop_screen_recording"}
<- {"type":"screen_recording_stopped","ok":true,"error":null}
```

The browser opens the recording with the backend first and passes the URLs and a
token that can do nothing but deliver that one file. The upload happens after
the reply, in the background, because by then the participant is already on the
next screen — which is also why the bridge reports its own late failures to
`failed_url` rather than back over this socket.

**Where the bytes go.** The bridge asks `session_url` first. A hosted backend
answers with a resumable session in its bucket, and the capture is PUT there
directly, 8 MiB at a time — a hosted app cannot be relied on to carry a body of
a few hundred megabytes, and Cloud Run in particular refuses one over 32 MiB.
Only the metadata then goes to `complete_url`, which checks the stored object
and closes the row. A backend storing files on its own disk answers `proxy`
instead, and the file is posted to `upload_url` as before.

A chunk that fails is retried from wherever the bucket says it got to, rather
than restarting the whole capture. If the upload cannot be finished at all the
file is kept locally and the failure reported, exactly as before.

## Binding and origins

The bridge listens on `127.0.0.1` by default: the browser is on the same
machine, and a participant's live gaze has no business on the lab network. Pass
`--host 0.0.0.0` if you really do need it reachable from elsewhere.

It also refuses connections whose `Origin` is not the study's own page, so
another tab cannot read the participant's gaze. The default allows
`http://localhost:5175`; add others with `--allow-origin`, repeatable:

```bash
python tobii_bridge.py --allow-origin https://a04.example.org
```

One tracker is shared across connections, so a second tab does not fight the
first for the subscription or for calibration mode.

## Clocks

Gaze samples are stamped with this machine's wall clock, and so are the
browser's playback events and note snapshots (`client_ts`) and the screen
recording's `epoch_ms` — that shared clock is what every timeline mapping relies
on. The backend's own timestamps are not used for it, so the backend does not
have to run on this host.
