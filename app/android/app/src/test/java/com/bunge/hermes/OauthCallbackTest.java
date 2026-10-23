package com.bunge.hermes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class OauthCallbackTest {

    @Test
    public void matchesTheRegisteredRedirectExactly() {
        OauthCallback match = OauthCallback.match("http://127.0.0.1/?code=c%2B1&state=s-1");
        assertNotNull(match);
        assertEquals("c+1", match.code);
        assertEquals("s-1", match.state);
        assertNotNull(OauthCallback.match("http://127.0.0.1:80/?state=s&code=c"));
    }

    @Test
    public void rejectsEverythingElse() {
        String[] rejected = {
            null,
            "http://127.0.0.1/?code=c", // no state
            "http://127.0.0.1/?state=s", // no code
            "http://127.0.0.1:8123/?code=c&state=s", // other port
            "http://127.0.0.1/unrelated?code=c&state=s", // other path
            "http://127.0.0.1?code=c&state=s", // empty path
            "https://127.0.0.1/?code=c&state=s", // https
            "http://[::1]/?code=c&state=s", // other loopback address
            "http://localhost/?code=c&state=s", // name, not the literal
            "http://127.0.0.2/?code=c&state=s",
            "http://user@127.0.0.1/?code=c&state=s", // userinfo
            "http://127.0.0.1/?code=c&state=s#frag", // fragment
            "http://127.0.0.1.evil.example/?code=c&state=s",
            "not a url ::",
        };
        for (String url : rejected) {
            assertNull(url, OauthCallback.match(url));
        }
    }
}
