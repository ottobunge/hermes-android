package com.bunge.hermes;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;

/**
 * The gated-gateway sign-in's loopback callback, matched EXACTLY (src/platform/oauth.ts
 * always registers redirect_uri http://127.0.0.1/): scheme http, host 127.0.0.1, no
 * userinfo, port absent or 80, path exactly "/", no fragment, and both `code` and
 * `state` present. Anything else is not a callback. Pure Java so it is unit-tested
 * off-device (OauthCallbackTest).
 */
final class OauthCallback {

    final String code;
    final String state;

    private OauthCallback(String code, String state) {
        this.code = code;
        this.state = state;
    }

    static OauthCallback match(String url) {
        if (url == null) {
            return null;
        }
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            return null;
        }
        if (
            !"http".equals(uri.getScheme()) ||
            !"127.0.0.1".equals(uri.getHost()) ||
            uri.getRawUserInfo() != null ||
            (uri.getPort() != -1 && uri.getPort() != 80) ||
            !"/".equals(uri.getRawPath()) ||
            uri.getRawFragment() != null
        ) {
            return null;
        }
        String code = param(uri.getRawQuery(), "code");
        String state = param(uri.getRawQuery(), "state");
        return code != null && state != null ? new OauthCallback(code, state) : null;
    }

    static String param(String rawQuery, String name) {
        if (rawQuery == null) {
            return null;
        }
        for (String pair : rawQuery.split("&")) {
            int eq = pair.indexOf('=');
            String key = eq < 0 ? pair : pair.substring(0, eq);
            if (name.equals(key)) {
                try {
                    return URLDecoder.decode(eq < 0 ? "" : pair.substring(eq + 1), "UTF-8");
                } catch (UnsupportedEncodingException | IllegalArgumentException e) {
                    return null;
                }
            }
        }
        return null;
    }
}
