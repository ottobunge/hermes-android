package com.bunge.hermes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.junit.Test;

public class SignInSessionTest {

    private static final String APP = "http://localhost";
    private static final String STATE = "state-1";
    private static final String AUTHORIZE =
        "http://10.0.2.2:9119/auth/native/authorize?code_challenge=x&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%2F&state=" +
        STATE;

    /** The WebView as SignInSession sees it: which Java objects are exposed, and what loaded. */
    static final class FakeHost implements SignInSession.Host {

        final Set<String> exposed;
        final List<String> loads = new ArrayList<>();

        FakeHost(String... exposed) {
            this.exposed = new LinkedHashSet<>(Arrays.asList(exposed));
        }

        @Override
        public Set<String> installedInterfaces() {
            return new LinkedHashSet<>(exposed);
        }

        @Override
        public void removeInterface(String name) {
            exposed.remove(name);
        }

        @Override
        public void restoreInterface(String name) {
            exposed.add(name);
        }

        @Override
        public void load(String url) {
            loads.add(url);
        }
    }

    // Capacitor's bridge configurations. Modern: androidBridge is an origin-scoped
    // WebMessageListener, not a Java object. Every other case — unsupported feature, legacy
    // bridge, listener installation threw — exposes the Java androidBridge.
    private static final String[] MODERN = { "CapacitorHttpAndroidInterface", "CapacitorCookiesAndroidInterface" };
    private static final String[] JAVA_BRIDGE = {
        "androidBridge",
        "CapacitorHttpAndroidInterface",
        "CapacitorCookiesAndroidInterface"
    };

    @Test
    public void wrongStateDuringAnActiveFlowIsBlockedAndTheGenuineCallbackStillCompletes() {
        FakeHost host = new FakeHost(JAVA_BRIDGE);
        SignInSession session = new SignInSession(host, APP);
        session.begin(AUTHORIZE, STATE, SignInSession.REDIRECT_URI);

        assertEquals(SignInSession.Kind.BLOCK, session.onNavigation("http://127.0.0.1/?code=attack&state=wrong", true));
        assertTrue("still armed", session.isArmed());
        assertTrue("interfaces still detached", host.exposed.isEmpty());
        assertEquals("nothing reloaded", Arrays.asList(AUTHORIZE), host.loads);

        assertEquals(SignInSession.Kind.COMPLETED, session.onNavigation("http://127.0.0.1/?code=real%2B1&state=" + STATE, true));
        assertFalse(session.isArmed());
        assertEquals(APP + "/?oauth-code=real%2B1&oauth-state=" + STATE, host.loads.get(1));
        assertEquals(new LinkedHashSet<>(Arrays.asList(JAVA_BRIDGE)), host.exposed);
    }

    @Test
    public void nothingIsInterceptedWhileIdle() {
        FakeHost host = new FakeHost(MODERN);
        SignInSession session = new SignInSession(host, APP);

        assertEquals(SignInSession.Kind.DEFAULT, session.onNavigation("http://127.0.0.1/?code=c&state=" + STATE, true));
        assertEquals(SignInSession.Kind.DEFAULT, session.onNavigation("http://10.0.2.2:9119/auth/native/authorize?state=x", true));
        assertTrue(host.loads.isEmpty());
        assertEquals(new LinkedHashSet<>(Arrays.asList(MODERN)), host.exposed);
    }

    @Test
    public void duringAFlowForeignPagesStayInTheWebViewButSubframesAndTheAppDoNot() {
        SignInSession session = new SignInSession(new FakeHost(MODERN), APP);
        session.begin(AUTHORIZE, STATE, SignInSession.REDIRECT_URI);

        assertEquals(SignInSession.Kind.STAY, session.onNavigation("http://10.0.2.2:9119/login", true));
        assertEquals(SignInSession.Kind.STAY, session.onNavigation("https://idp.example/authorize", true));
        assertEquals(SignInSession.Kind.DEFAULT, session.onNavigation("http://127.0.0.1/?code=c&state=" + STATE, false));
        assertEquals(SignInSession.Kind.DEFAULT, session.onNavigation(APP + "/", true));
        // Wrong redirect shapes are not callbacks — and not app loads either.
        assertEquals(SignInSession.Kind.STAY, session.onNavigation("http://127.0.0.1:8123/?code=c&state=" + STATE, true));
        assertTrue(session.isArmed());
    }

    @Test
    public void aSecondSignInWorksAfterCompletionAndAfterBackCancellation_inEveryBridgeConfiguration() {
        for (String[] config : new String[][] { MODERN, JAVA_BRIDGE }) {
            Set<String> original = new LinkedHashSet<>(Arrays.asList(config));
            FakeHost host = new FakeHost(config);
            SignInSession session = new SignInSession(host, APP);

            // 1st: completed by the genuine callback.
            session.begin(AUTHORIZE, STATE, SignInSession.REDIRECT_URI);
            assertTrue(host.exposed.isEmpty());
            assertEquals(SignInSession.Kind.COMPLETED, session.onNavigation("http://127.0.0.1/?code=c&state=" + STATE, true));
            assertEquals(original, host.exposed);
            assertFalse("restored before the app loaded: no extra reload", session.onAppOriginStarted());

            // 2nd: cancelled with Back (the app origin loads without a callback).
            session.begin(AUTHORIZE, STATE, SignInSession.REDIRECT_URI);
            assertTrue(host.exposed.isEmpty());
            assertTrue("restored → caller reloads once", session.onAppOriginStarted());
            assertEquals(original, host.exposed);
            assertFalse("no reload loop", session.onAppOriginStarted());

            // 3rd: still works.
            session.begin(AUTHORIZE, STATE, SignInSession.REDIRECT_URI);
            assertTrue(host.exposed.isEmpty());
            assertEquals(SignInSession.Kind.COMPLETED, session.onNavigation("http://127.0.0.1/?code=c&state=" + STATE, true));
            assertEquals(original, host.exposed);
        }
    }

    @Test
    public void beginRejectsAnAuthorizeUrlThatDoesNotCarryTheExpectedStateOrRedirect() {
        String[][] bad = {
            { AUTHORIZE, "other-state", SignInSession.REDIRECT_URI },
            { AUTHORIZE, STATE, "http://127.0.0.1:8123/" },
            { AUTHORIZE.replace("redirect_uri=http%3A%2F%2F127.0.0.1%2F", "redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2F"), STATE, SignInSession.REDIRECT_URI },
            { AUTHORIZE.replace("/auth/native/authorize", "/somewhere"), STATE, SignInSession.REDIRECT_URI },
            { "javascript:alert(1)", STATE, SignInSession.REDIRECT_URI },
            { AUTHORIZE, "", SignInSession.REDIRECT_URI },
        };
        for (String[] args : bad) {
            FakeHost host = new FakeHost(JAVA_BRIDGE);
            try {
                new SignInSession(host, APP).begin(args[0], args[1], args[2]);
                fail("accepted " + Arrays.toString(args));
            } catch (IllegalArgumentException expected) {
                assertEquals("nothing detached or loaded", 3, host.exposed.size());
                assertTrue(host.loads.isEmpty());
            }
        }
    }

    // The transport probe MainActivity uses to decide whether androidBridge is a Java object.
    static final class HandlerWithModernChannel {

        @SuppressWarnings("unused")
        private Object javaScriptReplyProxy = new Object();
    }

    static final class HandlerOnJavaBridge {

        @SuppressWarnings("unused")
        private Object javaScriptReplyProxy = null;
    }

    @Test
    public void theTransportProbeReadsCapacitorsOwnChannelRecord() throws Exception {
        assertFalse(SignInSession.javaBridgeInUse(new HandlerWithModernChannel()));
        assertTrue("fallback, incl. listener-installation failure", SignInSession.javaBridgeInUse(new HandlerOnJavaBridge()));
        assertFalse(SignInSession.javaBridgeInUse(null));
        assertTrue("unreadable → assume it is there", SignInSession.javaBridgeInUse(new Object()));

        // The reflected fields exist on the pinned Capacitor classes (guards an upgrade).
        assertNotNull(com.getcapacitor.MessageHandler.class.getDeclaredField("javaScriptReplyProxy"));
        assertNotNull(com.getcapacitor.Bridge.class.getDeclaredField("msgHandler"));
    }
}
