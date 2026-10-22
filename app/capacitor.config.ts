import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.bunge.hermes',
  appName: 'Hermes',
  webDir: 'dist',
  android: {
    // Self-hosted gateways are often plain http:// on a LAN/tailnet; the page
    // itself stays on the secure https://localhost origin (which the gateway's
    // CORS policy already admits).
    allowMixedContent: true
  }
}

export default config
