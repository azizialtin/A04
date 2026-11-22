# Lab setup checklist for study leads

For the eye-tracking sessions on the lab laptops (15.6", 1920 × 1080, Edge).
Go through it before **each** participant. It takes about two minutes.

The app no longer stops a session because of a display setting. It shows you
the settings on the welcome page, records them, and carries on. When display
verification fails, received gaze samples retain their raw coordinates but
**cannot be assigned to areas of the page (AOIs)**. A missing tracker can also
mean no gaze samples are received. Check the setup before starting.

## Before the participant sits down

1. **One screen only.** Use the laptop screen the eye tracker is calibrated
   for. Unplug or disable any second monitor or projector.
2. **Windows display settings** (right-click the desktop → *Display settings*):
   - *Display resolution*: **1920 × 1080**
   - *Scale*: **100 %**. These laptops are delivered at 125 % — change it.
3. **Eye tracker.** Calibrate in Tobii Pro Eye Tracker Manager on this screen,
   as usual.
4. **Bridge.** Start the current `A04Bridge.exe` and leave its window open.
5. **Edge.**
   - Open the study page. A login page left open from an earlier day brings
     itself up to date: it asks the server when you return to the window and
     when **Anmelden** is pressed, and reloads if a newer release is live. The
     typed ID is kept; if the page reloads when **Anmelden** is pressed, press
     it once more. Should it show “Diese Seite ist nicht auf dem neuesten
     Stand”, press **Ctrl + F5**. A page that was already open when this
     arrived (app version `2026-11-22.1`) cannot do it yet: reload that page
     once with **Ctrl + F5**.
   - Press **Ctrl + 0** to reset the zoom to 100 %.
   - Press **F11** for full screen.
   - If Edge asks whether the site may access apps on this device (or the
     local network), choose **Allow**.

## On the first page, after logging the participant in

6. Read the settings summary below the welcome text. It starts collapsed,
   including when a setting needs attention. Click the line to expand it.
7. The expanded list contains only different or unverified settings. Each
   setting shows **Aktuell** and **Vorgesehen** on separate lines. If any appear:

| Setting | What to check |
|---|---|
| Windows-Bridge | Start `A04Bridge.exe`, then click **Bridge erneut verbinden**. “Ältere Version” means the bridge works but should be updated; settings 2 and 5 are then mandatory. |
| Bildschirmauflösung | Step 2: resolution 1920 × 1080. A value such as 1536 × 864 means the scale is 125 %. |
| Windows-Skalierung × Browser-Zoom | Step 2 (scale 100 %) and Ctrl + 0 in Edge. |
| Browserfläche der Studienseite | Press F11. Close side panels and developer tools in Edge. |
| Vollbild | Press F11, or click **Vollbild öffnen**. |
| Angeschlossene Bildschirme | Step 1: disconnect the second screen. |
| Seite per Geste vergrößert | Pinch out on the touchpad until the page is back to normal size. |
| Studienfenster im Vordergrund | Click once on the study page. |
| AOI-Zuordnung | Fix the rows above; this one follows within a second. “Bereit” on this page is correct — it becomes “aktiv” on the study pages. |

8. When the summary reads **“Die Bildschirmeinstellungen sind in Ordnung.”**,
   let the participant start. Unknown settings remain listed until they can be
   checked; do not interpret them as confirmed. No confirmation button is needed.

## During the session

- Setup details stay on the welcome page. Questionnaires, introductions and
  videos do not show persistent tracking or display-warning boxes.
- Capture, automatic recovery and verification continue in the background.
  Validate recording and mapping in a short synthetic run before collecting
  participant data; the absence of a warning is not proof of successful tracking.
- Please ask participants not to press **Esc** or **F11**, not to zoom
  (Ctrl + mouse wheel, Ctrl + plus/minus), and not to switch to other windows.

## Afterwards

- Review recorded interruption/resume events and exported mapping status for
  periods when the display was unverified. Received gaze from those periods
  retains raw coordinates but has no assigned areas.

## What the app does not check

- Whether the eye tracker is calibrated for *this* screen and *this* person.
- Whether the participant sits within the tracker's range.

If something does not behave as described here, record the time, browser and
release being used and tell the development team.
