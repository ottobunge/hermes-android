import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.bunge.hermes',
  appName: 'Hermes',
  webDir: 'dist',
  // Test-rig policy (debug builds only): allow plain-http/ws gateways on
  // private addresses (emulator host loopback, LAN labs). HTTPS/WSS stays the
  // supported production path; a release build must not ship this.
  server: {
    cleartext: true,
    // http origin so ws:// gateway dials aren't mixed-content-blocked.
    androidScheme: 'http',
  },
}

export default config
