import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import de from './locales/de.json'
import en from './locales/en.json'
import displayGuardDe from './locales/display-guard.de.json'
import displayGuardEn from './locales/display-guard.en.json'

const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('a04_lang') : null

// Guard so importing this twice (app + test setup) doesn't re-init.
if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: {
      de: { translation: de, displayGuard: displayGuardDe },
      en: { translation: en, displayGuard: displayGuardEn },
    },
    defaultNS: 'translation',
    lng: stored ?? 'de',
    fallbackLng: 'de',
    interpolation: { escapeValue: false },
  })
}

export default i18n
