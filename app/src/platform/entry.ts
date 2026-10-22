// Android adaptation layer — the page entry (index.html points here instead of
// src/main.tsx). Installs the bridge BEFORE any renderer module evaluates, then
// boots the unmodified desktop renderer, or onboarding when no gateway is saved.

import { installBridge } from './bridge'
import { loadGateway } from './gateway-config'
import { installPhoneLayout } from './phone-layout'

installBridge()
installPhoneLayout()

if (loadGateway()) {
  void import('../main')
} else {
  void import('./onboarding').then(({ mountOnboarding }) => mountOnboarding())
}
