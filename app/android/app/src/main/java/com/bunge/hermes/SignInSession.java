package com.bunge.hermes;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * The native half of a gated-gateway sign-in, as a pure-Java state machine (no Android types,
 * so SignInSessionTest drives it off-device). MainActivity.GatewaySignInClient feeds it
 * navigations and applies its decisions to the WebView through {@link Host}.
 *
 * Armed only by {@link #begin}, i.e. by HermesOauthPlugin.beginSignIn, which the app calls
 * right after persisting its pending PKCE/state record. begin() retains the EXPECTED state and
 * redirect URI; a callback is completed only when it has exactly the registered redirect shape
 * (OauthCallback) AND that state. A redirect-shaped navigation carrying any other state during
 * an active flow is blocked outright: not rewritten, not disarmed, not handed to the system
 * browser — the genuine callback can still complete afterwards.
 *
 * Interfaces: begin() records which Java objects are actually exposed (Host.installedInterfaces —
 * including androidBridge whenever Capacitor's MessageHandler uses it, whatever the reason) and
 * removes exactly those; completion or cancellation restores exactly that set.
 */
final class SignInSession {

    static final String REDIRECT_URI = "http://127.0.0.1/";

    interface Host {
        /** The Java objects currently exposed with addJavascriptInterface, by name. */
        Set<String> installedInterfaces();

        void removeInterface(String name);

        void restoreInterface(String name);

        void load(String url);
    }

    enum Kind {
        /** Not ours: Capacitor's default handling. */
        DEFAULT,
        /** Keep this navigation inside the (detached) WebView. */
        STAY,
        /** Cancel this navigation and change nothing (wrong-state callback). */
        BLOCK,
        /** The genuine callback: the app was reloaded with oauth-code/oauth-state. */
        COMPLETED
    }

    private final Host host;
    private final String appOrigin;
    private String expectedState;
    private Set<String> detached = null;

    SignInSession(Host host, String appUrl) {
        this.host = host;
        this.appOrigin = origin(appUrl);
    }

    boolean isArmed() {
        return expectedState != null;
    }

    /** Validates, detaches the exposed interfaces, arms, and loads the authorize URL. */
    void begin(String authorizeUrl, String state, String redirectUri) {
        validate(authorizeUrl, state, redirectUri);

        if (detached == null) {
            detached = new LinkedHashSet<>(host.installedInterfaces());
            for (String name : detached) {
                host.removeInterface(name);
            }
        }
        expectedState = state;
        host.load(authorizeUrl);
    }

    /** The authorize URL must carry exactly the expected state and the registered redirect. */
    static void validate(String authorizeUrl, String state, String redirectUri) {
        if (state == null || state.isEmpty()) {
            throw new IllegalArgumentException("expected state required");
        }
        if (!REDIRECT_URI.equals(redirectUri)) {
            throw new IllegalArgumentException("redirect_uri must be " + REDIRECT_URI);
        }
        URI uri;
        try {
            uri = new URI(authorizeUrl);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("invalid authorize URL");
        }
        String scheme = uri.getScheme();
        if (
            !("https".equals(scheme) || "http".equals(scheme)) ||
            uri.getRawPath() == null ||
            !uri.getRawPath().endsWith("/auth/native/authorize") ||
            !state.equals(OauthCallback.param(uri.getRawQuery(), "state")) ||
            !redirectUri.equals(OauthCallback.param(uri.getRawQuery(), "redirect_uri"))
        ) {
            throw new IllegalArgumentException("authorize URL does not carry the expected state/redirect_uri");
        }
    }

    /** A main-frame navigation while the client decides; subframes always get DEFAULT. */
    Kind onNavigation(String url, boolean mainFrame) {
        if (!isArmed() || !mainFrame) {
            return Kind.DEFAULT;
        }

        OauthCallback callback = OauthCallback.match(url);
        if (callback != null) {
            if (!expectedState.equals(callback.state)) {
                return Kind.BLOCK;
            }
            expectedState = null;
            restore(); // before the app load: added objects appear at the next load
            host.load(appOrigin + "/?oauth-code=" + encode(callback.code) + "&oauth-state=" + encode(callback.state));
            return Kind.COMPLETED;
        }

        String origin = origin(url);
        boolean http = url != null && (url.startsWith("http://") || url.startsWith("https://"));
        return http && !appOrigin.equals(origin) ? Kind.STAY : Kind.DEFAULT;
    }

    /**
     * The app origin started loading. Disarms; if the interfaces are still detached (Back out
     * of the login page, no callback), restores them and returns true: the caller reloads once
     * so this app document gets them.
     */
    boolean onAppOriginStarted() {
        expectedState = null;
        return restore();
    }

    /**
     * Whether Capacitor's MessageHandler speaks through the Java "androidBridge" object. It
     * records the modern channel itself: javaScriptReplyProxy is set when a message arrives
     * through the WebMessageListener and stays null when messages come through the Java object.
     * begin() runs right after the beginSignIn message was handled, so this reflects the
     * transport actually in use — including the fallback after listener installation threw.
     * Unreadable → true (removing an absent object is a no-op; restoring keeps the app working).
     */
    static boolean javaBridgeInUse(Object messageHandler) {
        if (messageHandler == null) {
            return false;
        }
        try {
            java.lang.reflect.Field proxy = messageHandler.getClass().getDeclaredField("javaScriptReplyProxy");
            proxy.setAccessible(true);
            return proxy.get(messageHandler) == null;
        } catch (ReflectiveOperationException e) {
            return true;
        }
    }

    boolean isAppOrigin(String url) {
        return appOrigin.equals(origin(url));
    }

    private boolean restore() {
        if (detached == null) {
            return false;
        }
        for (String name : detached) {
            host.restoreInterface(name);
        }
        detached = null;
        return true;
    }

    private static String origin(String url) {
        try {
            URI uri = new URI(url);
            if (uri.getScheme() == null || uri.getRawAuthority() == null) {
                return "";
            }
            return uri.getScheme() + "://" + uri.getRawAuthority();
        } catch (URISyntaxException | NullPointerException e) {
            return "";
        }
    }

    private static String encode(String value) {
        try {
            return java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }
}
