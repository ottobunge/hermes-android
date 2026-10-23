import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.bunge.hermes',
  appName: 'Hermes',
  webDir: 'dist',
  // Network policy is deliberately unset until the native project exists:
  // HTTPS/WSS gateways are the supported path. Plain http:// on Android needs
  // an explicit cleartext policy (server.cleartext / networkSecurityConfig),
  // which `allowMixedContent` does NOT provide — decide it when android/ is
  // generated (README "Deviations").
}

export default config
