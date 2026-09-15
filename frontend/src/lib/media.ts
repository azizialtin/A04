/**
 * A WebM written by MediaRecorder has no duration in its header — the browser
 * did not know it when it started — so `<video>` reports Infinity, the scrubber
 * is dead and the end cannot be found. Seeking far past the end once makes the
 * browser scan the file and fill the duration in; then go back to the start.
 * A file with a real duration is left alone.
 */
export function settleDuration(video: HTMLVideoElement): void {
  if (Number.isFinite(video.duration)) return
  const restore = () => {
    video.removeEventListener('timeupdate', restore)
    video.currentTime = 0
  }
  video.addEventListener('timeupdate', restore)
  video.currentTime = 1e101
}
