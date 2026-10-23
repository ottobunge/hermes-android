// Android adaptation layer — the page entry (index.html points here instead of
// src/main.tsx). Installs the bridge BEFORE any renderer module evaluates, then
// boots the unmodified desktop renderer, or onboarding when no gateway is saved.

import { installBridge } from './bridge'
import { loadGateway } from './gateway-config'
import { completeOauthRedirect, takeOauthNotice } from './oauth'
import { installPhoneLayout } from './phone-layout'
import { installWebviewFallback } from './webview-unavailable'

installBridge()
installPhoneLayout()
installWebviewFallback()

// A gated-gateway sign-in comes back as a fresh page load (oauth.ts): redeem
// it before deciding what to boot, so a successful sign-in boots connected.
void completeOauthRedirect().then(() => {
  if (!loadGateway()) {
    void import('./onboarding').then(({ mountOnboarding }) => mountOnboarding())

    return
  }

  const notice = takeOauthNotice()

  void import('../main').then(async () => {
    if (notice) {
      const { notify } = await import('@/store/notifications')
      notify({
        kind: notice.kind === 'cancelled' ? 'info' : 'error',
        title: notice.kind === 'cancelled' ? 'Sign-in cancelled' : 'Sign-in failed',
        message: notice.message
      })
    }
  })
})
