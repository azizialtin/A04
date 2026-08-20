import { Component, type ReactNode } from 'react'

import apiClient from '../api/client'

interface State {
  hasError: boolean
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('Unhandled UI error', error)
    // A crash mid-session is something the researchers need to know happened,
    // not something that disappears with the tab. Best effort: if the token has
    // gone too, there is nowhere to send it.
    void apiClient
      .post('/participant/events', {
        event_type: 'ui_error',
        client_ts: Date.now(),
        payload: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack?.slice(0, 2000) : undefined,
          path: window.location.pathname,
        },
      })
      .catch(() => {})
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fullpage">
          <p className="muted">Etwas ist schiefgelaufen. Bitte laden Sie die Seite neu.</p>
        </div>
      )
    }
    return this.props.children
  }
}
