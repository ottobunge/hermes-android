package com.bunge.hermes;

import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new GatewaySignInClient(bridge));
    }

    /**
     * Gated-gateway sign-in (src/platform/oauth.ts, RFC 8252 native flow).
     *
     * The app navigates the whole WebView to the gateway's
     * /auth/native/authorize. Capacitor would hand that (and every other
     * non-app host) to the system browser, so from that request until the app
     * origin loads again, main-frame http(s) navigations stay in the WebView:
     * the gateway's /login page, a provider chooser, or an upstream IdP.
     * Capacitor injects its native bridge only into the app origin, so those
     * pages never see it.
     *
     * The gateway finishes at http://127.0.0.1[:port]/?code=…&state=… where
     * nothing listens: that one navigation is rewritten to
     * {app}/?oauth-code=…&oauth-state=…, which the app redeems on load.
     * Everything else is Capacitor's default handling.
     */
    static final class GatewaySignInClient extends BridgeWebViewClient {

        private final Bridge bridge;
        private boolean signingIn = false;

        GatewaySignInClient(Bridge bridge) {
            super(bridge);
            this.bridge = bridge;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();

            if (request.isForMainFrame() && isLoopbackCallback(url)) {
                signingIn = false;
                Uri app = Uri.parse(bridge.getAppUrl());
                Uri.Builder back = new Uri.Builder().scheme(app.getScheme()).encodedAuthority(app.getEncodedAuthority()).path("/");
                back.appendQueryParameter("oauth-code", url.getQueryParameter("code"));
                back.appendQueryParameter("oauth-state", String.valueOf(url.getQueryParameter("state")));
                view.loadUrl(back.build().toString());
                return true;
            }

            String path = url.getPath();
            if (request.isForMainFrame() && isHttp(url) && path != null && path.endsWith("/auth/native/authorize")) {
                signingIn = true;
                return false;
            }

            if (signingIn && request.isForMainFrame() && isHttp(url) && !isAppOrigin(url)) {
                return false;
            }

            return super.shouldOverrideUrlLoading(view, request);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            // Back in the app (a finished sign-in, or Back out of the gateway's
            // login page): stop keeping foreign navigations in the WebView.
            if (url != null && isAppOrigin(Uri.parse(url))) {
                signingIn = false;
            }
            super.onPageStarted(view, url, favicon);
        }

        private static boolean isHttp(Uri url) {
            return "http".equals(url.getScheme()) || "https".equals(url.getScheme());
        }

        private static boolean isLoopbackCallback(Uri url) {
            String host = url.getHost();
            return (
                "http".equals(url.getScheme()) &&
                ("127.0.0.1".equals(host) || "[::1]".equals(host) || "::1".equals(host)) &&
                url.getQueryParameter("code") != null
            );
        }

        private boolean isAppOrigin(Uri url) {
            Uri app = Uri.parse(bridge.getAppUrl());
            return (
                app.getScheme() != null &&
                app.getScheme().equals(url.getScheme()) &&
                app.getEncodedAuthority() != null &&
                app.getEncodedAuthority().equals(url.getEncodedAuthority())
            );
        }
    }
}
