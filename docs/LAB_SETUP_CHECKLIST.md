# Lab setup checklist for study leads

For the eye-tracking sessions on the lab laptops (15.6", 1920 × 1080, Edge).
Go through it before **each** participant. It takes about two minutes.

The app no longer stops a session because of a display setting. It shows you
the settings, records them, and carries on. The price of a wrong setting is
that the gaze of that session is saved but **cannot be assigned to areas of the
page (AOIs)**. So the check below is what protects the data.

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
   - Open the study page.
   - Press **Ctrl + 0** to reset the zoom to 100 %.
   - Press **F11** for full screen.
   - If Edge asks whether the site may access apps on this device (or the
     local network), choose **Allow**.

## On the first page, after logging the participant in

6. Open **“Bildschirmeinstellung prüfen”** below the welcome text. It is
   already open if something needs attention.
7. Every row should read **“in Ordnung”**. If one does not:

| Row | If it does not say “in Ordnung” |
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

8. When all rows are in order, let the participant start. You do not need to
   confirm anything.

## During the session

- A small green note **“AOI-Zuordnung aktiv.”** at the top left means gaze is
  being assigned to areas.
- A yellow note **“Blickdaten werden gerade keinen Bereichen zugeordnet.”**
  means a setting has changed. The participant can keep working. Click
  **Einstellungen anzeigen** to see which one, and correct it at the next
  quiet moment (usually F11, Ctrl + 0, or a click on the study page). It
  recovers by itself; there is nothing to confirm.
- Please ask participants not to press **Esc** or **F11**, not to zoom
  (Ctrl + mouse wheel, Ctrl + plus/minus), and not to switch to other windows.

## Afterwards

- If the yellow note was visible for more than a moment, write down roughly
  when and for how long. Gaze from that stretch is saved but has no areas.

## What the app does not check

- Whether the eye tracker is calibrated for *this* screen and *this* person.
- Whether the participant sits within the tracker's range.

If something does not behave as described here, note the app version shown
under **Technischer Status** and tell the development team.
