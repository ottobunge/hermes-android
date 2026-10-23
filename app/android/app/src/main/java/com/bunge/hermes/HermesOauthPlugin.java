package com.bunge.hermes;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The ONLY way a gated-gateway sign-in starts natively: src/platform/oauth.ts calls
 * HermesOauth.beginSignIn({ url, state, redirectUri }) right after persisting its pending
 * PKCE/state record. Native retains the expected state (SignInSession), detaches the exposed
 * Java interfaces and loads the authorize URL itself, so a foreign document can never arm
 * sign-in mode, complete it with another state, or reach a native interface.
 */
@CapacitorPlugin(name = "HermesOauth")
public class HermesOauthPlugin extends Plugin {

    @PluginMethod
    public void beginSignIn(PluginCall call) {
        String url = call.getString("url");
        String state = call.getString("state");
        String redirectUri = call.getString("redirectUri");

        try {
            SignInSession.validate(url, state, redirectUri);
        } catch (IllegalArgumentException e) {
            call.reject("beginSignIn: " + e.getMessage());
            return;
        }
        if (!(getBridge().getWebViewClient() instanceof MainActivity.GatewaySignInClient)) {
            call.reject("gateway sign-in client not installed");
            return;
        }
        MainActivity.GatewaySignInClient client = (MainActivity.GatewaySignInClient) getBridge().getWebViewClient();
        // Resolve first: the reply travels over the bridge that begin() detaches.
        call.resolve();
        getBridge().executeOnMainThread(() -> client.begin(getBridge().getWebView(), url, state, redirectUri));
    }
}
