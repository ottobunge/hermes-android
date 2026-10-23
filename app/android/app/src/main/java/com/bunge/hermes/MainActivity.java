package com.bunge.hermes;

import android.graphics.Bitmap;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Logger;
import com.getcapacitor.PluginHandle;
import java.lang.reflect.Field;
import java.util.LinkedHashSet;
import java.util.Set;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HermesOauthPlugin.class);
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new GatewaySignInClient(bridge));
    }

    /**
     * Gated-gateway sign-in (src/platform/oauth.ts, the gateway's RFC 8252 native-app endpoints,
     * run in this WebView — an embedded user agent, an accepted deviation from RFC 8252 §8.12;
     * see the README). The decisions live in {@link SignInSession} (pure Java, unit-tested);
     * this class adapts them to the WebView.
     *
     * Trust boundary: no callable native Java object while a non-app document is in the main
     * frame. Capacitor exposes, via addJavascriptInterface (visible to EVERY origin):
     * "androidBridge" whenever its MessageHandler uses the Java bridge (WebMessageListener
     * unsupported, legacy bridge, or listener installation threw), and the always-registered
     * "CapacitorHttpAndroidInterface" / "CapacitorCookiesAndroidInterface". The origin-scoped
     * WebMessageListener bridge is left alone. begin() removes exactly the installed set before
     * loading the gateway and restores exactly that set before the app origin loads again.
     */
    static final class GatewaySignInClient extends BridgeWebViewClient {

        private final Bridge bridge;
        private WebView view;
        private final SignInSession session;

        GatewaySignInClient(Bridge bridge) {
            super(bridge);
            this.bridge = bridge;
            this.view = bridge.getWebView();
            this.session = new SignInSession(new WebViewHost(), bridge.getAppUrl());
        }

        /** HermesOauthPlugin.beginSignIn, on the main thread. */
        void begin(WebView view, String authorizeUrl, String state, String redirectUri) {
            this.view = view;
            session.begin(authorizeUrl, state, redirectUri);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            this.view = view;
            switch (session.onNavigation(request.getUrl().toString(), request.isForMainFrame())) {
                case STAY:
                    return false;
                case BLOCK:
                case COMPLETED:
                    return true;
                default:
                    return super.shouldOverrideUrlLoading(view, request);
            }
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            this.view = view;
            // Back in the app without a callback (Back out of the login page): disarm, restore
            // the interfaces, and reload once so this app document has them.
            if (url != null && session.isAppOrigin(url) && session.onAppOriginStarted()) {
                view.post(view::reload);
            }
            super.onPageStarted(view, url, favicon);
        }

        private final class WebViewHost implements SignInSession.Host {

            @Override
            public Set<String> installedInterfaces() {
                Set<String> names = new LinkedHashSet<>();
                if (javaBridgeInUse()) {
                    names.add("androidBridge");
                }
                if (plugin("CapacitorHttp") != null) {
                    names.add("CapacitorHttpAndroidInterface");
                }
                if (plugin("CapacitorCookies") != null) {
                    names.add("CapacitorCookiesAndroidInterface");
                }
                return names;
            }

            @Override
            public void removeInterface(String name) {
                view.removeJavascriptInterface(name);
            }

            @Override
            public void restoreInterface(String name) {
                Object target =
                    "androidBridge".equals(name)
                        ? messageHandler()
                        : plugin("CapacitorHttpAndroidInterface".equals(name) ? "CapacitorHttp" : "CapacitorCookies");
                if (target != null) {
                    view.addJavascriptInterface(target, name);
                }
            }

            @Override
            public void load(String url) {
                view.loadUrl(url);
            }
        }

        private boolean javaBridgeInUse() {
            return SignInSession.javaBridgeInUse(messageHandler());
        }

        private Object messageHandler() {
            try {
                Field field = Bridge.class.getDeclaredField("msgHandler");
                field.setAccessible(true);
                return field.get(bridge);
            } catch (ReflectiveOperationException e) {
                Logger.error("HermesOauth: cannot reach MessageHandler", e);
                return null;
            }
        }

        private Object plugin(String pluginId) {
            PluginHandle handle = bridge.getPlugin(pluginId);
            return handle != null ? handle.getInstance() : null;
        }
    }
}
