import { useTranslation } from 'react-i18next'

const LANGS = ['de', 'en'] as const

export default function LanguageSwitcher() {
  const { i18n } = useTranslation()

  const pick = (lng: string) => {
    localStorage.setItem('a04_lang', lng)
    void i18n.changeLanguage(lng)
  }

  return (
    <div className="lang-switch" role="group" aria-label="Sprache / Language">
      {LANGS.map((lng) => (
        <button
          key={lng}
          type="button"
          className={`lang-switch__btn ${i18n.resolvedLanguage === lng ? 'is-active' : ''}`}
          onClick={() => pick(lng)}
        >
          {lng.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
