// Android adaptation layer — NOT part of the vendored desktop renderer.
//
// First run without a saved gateway: the desktop's own Settings → Gateway
// panel (the same `embedded` form the boot-failure recovery card mounts),
// framed by a one-line heading. The bridge's connection-config methods drive
// it; "Save & reconnect" tests the gateway (HTTP + /api/ws) and reloads into
// the full app.

import '../styles.css'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'

import { GatewaySettings } from '@/app/settings/gateway-settings'
import { NotificationStack } from '@/components/notifications'
import { RootTooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n/context'
import { queryClient } from '@/lib/query-client'
import { ThemeProvider } from '@/themes/context'

import { type OauthNotice, takeOauthNotice } from './oauth'

function Onboarding({ notice }: { notice: OauthNotice | null }) {
  return (
    <main className="flex min-h-dvh w-full items-start justify-center overflow-y-auto bg-background px-4 py-10 text-foreground sm:items-center">
      <div className="w-full max-w-[46rem] rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) py-5 shadow-nous">
        <div className="px-5 pb-4">
          <h1 className="text-[0.9375rem] font-semibold tracking-tight">Connect to a Hermes gateway</h1>
          <p className="mt-1 text-[0.8125rem] leading-5 text-(--ui-text-tertiary)">
            Hermes on Android is a client for a Hermes gateway running elsewhere (<code>hermes serve</code>). Enter
            its URL, then its session token or sign in. Use an <code>https://</code> gateway: plain{' '}
            <code>http://</code> sends credentials unencrypted and is only for a network you trust.
          </p>
          {notice ? (
            <p
              className={
                notice.kind === 'failed'
                  ? 'mt-3 rounded-lg border border-destructive/35 px-3 py-2 text-[0.8125rem] text-destructive'
                  : 'mt-3 rounded-lg border border-(--stroke-nous) px-3 py-2 text-[0.8125rem] text-(--ui-text-secondary)'
              }
              role={notice.kind === 'failed' ? 'alert' : 'status'}
            >
              {notice.message}
            </p>
          ) : null}
        </div>
        <GatewaySettings embedded />
      </div>
      <NotificationStack />
    </main>
  )
}

export function mountOnboarding(): void {
  // Read once: StrictMode double-renders, and the notice is one-shot.
  const notice = takeOauthNotice()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <I18nProvider configClient={null}>
          <ThemeProvider>
            <RootTooltipProvider>
              <HashRouter>
                <Onboarding notice={notice} />
              </HashRouter>
            </RootTooltipProvider>
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}
