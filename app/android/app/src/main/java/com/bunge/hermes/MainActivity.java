package com.bunge.hermes;

import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Logger;
import com.getcapacitor.PluginHandle;
import java.lang.reflect.Field;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HermesOauthPlugin.class);
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new GatewaySignInClient(bridge));
    }

    /**
     * Gated-gateway sign-in (src/platform/oauth.ts, RFC 8252 native flow, run in this
     * WebView — an embedded user agent, an accepted deviation from RFC 8252 §8.12; see the
     * README).
     *
     * Trust boundary: no callable native interface while a non-app document is in the main
     * frame. Capacitor exposes the app to native through (a) a WebMessageListener scoped to
     * the app origin on modern WebViews, and (b) Java objects added with
     * addJavascriptInterface, which Android exposes to EVERY origin: "androidBridge" when the
     * listener is unavailable (MessageHandler fallback), and the always-registered
     * "CapacitorHttpAndroidInterface" / "CapacitorCookiesAndroidInterface". begin() removes
     * all (b) objects before loading the gateway — a removal takes effect at that next load —
     * and they are added back before the app origin loads again.
     *
     * Sign-in mode is armed ONLY by begin() (HermesOauthPlugin.beginSignIn, called by the
     * app after it persisted its pending PKCE/state record). While armed, main-frame http(s)
     * navigation stays in the WebView (gateway /login, provider chooser, upstream IdP)
     * instead of Capacitor's system-browser hand-off, and exactly the registered redirect
     * http://127.0.0.1/?code=…&state=… (OauthCallback) is rewritten to
     * {app}/?oauth-code=…&oauth-state=…. Unarmed, nothing here intercepts anything.
     */
    static final class GatewaySignInClient extends BridgeWebViewClient {

        private static final String[] JS_INTERFACES = {
            "androidBridge",
            "CapacitorHttpAndroidInterface",
            "CapacitorCookiesAndroidInterface"
        };

        private final Bridge bridge;
        private boolean signingIn = false;
        private boolean detached = false;

        GatewaySignInClient(Bridge bridge) {
            super(bridge);
            this.bridge = bridge;
        }

        void begin(WebView view, String authorizeUrl) {
            detach(view);
            signingIn = true;
            view.loadUrl(authorizeUrl);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!signingIn || !request.isForMainFrame()) {
                return super.shouldOverrideUrlLoading(view, request);
            }

            OauthCallback callback = OauthCallback.match(request.getUrl().toString());
            if (callback != null) {
                signingIn = false;
                attach(view); // before the app load: added objects appear at the next load
                Uri app = Uri.parse(bridge.getAppUrl());
                Uri back = new Uri.Builder()
                    .scheme(app.getScheme())
                    .encodedAuthority(app.getEncodedAuthority())
                    .path("/")
                    .appendQueryParameter("oauth-code", callback.code)
                    .appendQueryParameter("oauth-state", callback.state)
                    .build();
                view.loadUrl(back.toString());
                return true;
            }

            Uri url = request.getUrl();
            boolean http = "http".equals(url.getScheme()) || "https".equals(url.getScheme());
            if (http && !isAppOrigin(url)) {
                return false; // stay in the (detached) WebView
            }

            return super.shouldOverrideUrlLoading(view, request);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (url != null && isAppOrigin(Uri.parse(url))) {
                // Back in the app without a callback (Back out of the login page): disarm, and
                // if the interfaces are still detached, restore them and reload once so this
                // app document has them.
                signingIn = false;
                if (detached) {
                    attach(view);
                    view.post(view::reload);
                }
            }
            super.onPageStarted(view, url, favicon);
        }

        private void detach(WebView view) {
            for (String name : JS_INTERFACES) {
                view.removeJavascriptInterface(name); // no-op when absent
            }
            detached = true;
        }

        private void attach(WebView view) {
            if (!detached) {
                return;
            }
            detached = false;
            // Mirror MessageHandler: "androidBridge" is a Java object only on the fallback path.
            // (If addWebMessageListener threw on a supporting WebView, Capacitor also falls back;
            // that case is not detectable here and is documented in the README.)
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || bridge.getConfig().isUsingLegacyBridge()) {
                Object handler = messageHandler();
                if (handler != null) {
                    view.addJavascriptInterface(handler, "androidBridge");
                }
            }
            addPlugin(view, "CapacitorHttp", "CapacitorHttpAndroidInterface");
            addPlugin(view, "CapacitorCookies", "CapacitorCookiesAndroidInterface");
        }

        private void addPlugin(WebView view, String pluginId, String name) {
            PluginHandle handle = bridge.getPlugin(pluginId);
            if (handle != null && handle.getInstance() != null) {
                view.addJavascriptInterface(handle.getInstance(), name);
            }
        }

        private Object messageHandler() {
            try {
                Field field = Bridge.class.getDeclaredField("msgHandler");
                field.setAccessible(true);
                return field.get(bridge);
            } catch (ReflectiveOperationException e) {
                Logger.error("HermesOauth: cannot restore androidBridge", e);
                return null;
            }
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
