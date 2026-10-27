import { useDownloadMedia } from '../../hooks/admin'
import { useToast } from '../Toast'

export default function MediaDownloadButton({
  kind,
  id,
  disabled = false,
}: {
  kind: 'video' | 'screen'
  id: number
  disabled?: boolean
}) {
  const download = useDownloadMedia()
  const toast = useToast()
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={disabled || download.isPending}
      onClick={() =>
        download.mutate(
          { kind, id },
          {
            onError: () => toast.show('Download nicht verfügbar. Bitte erneut versuchen.', 'error'),
          },
        )
      }
    >
      {download.isPending
        ? 'Download wird vorbereitet…'
        : kind === 'video'
          ? 'Stimulus herunterladen'
          : 'Bildschirmaufnahme herunterladen'}
    </button>
  )
}
