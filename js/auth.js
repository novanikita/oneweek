/**
 * Auth — email-link callbacks, the single session hub (`window.oneweekAuth`)
 * every panel subscribes to, logout, and the sign-in / sign-up modal.
 */

const EMAIL_OTP_TYPES = new Set([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

function getAuthEmailRedirectTo() {
  const origin = window.location.origin;
  if (!origin || origin === "null" || !/^https?:\/\//.test(origin)) return undefined;
  return `${origin}/`;
}

function readAuthCallbackParams() {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const get = (key) => url.searchParams.get(key) || hash.get(key) || "";
  return { url, get };
}

function friendlyAuthCallbackError(raw) {
  const msg = decodeURIComponent(String(raw || "").replace(/\+/g, " ")).trim();
  const lower = msg.toLowerCase();
  if (lower.includes("expired") || lower.includes("invalid")) {
    return "This confirmation link is invalid or has expired. Create the account again to get a new email.";
  }
  return msg || "Couldn't confirm email.";
}

function stripAuthCallbackFromAddress() {
  const url = new URL(window.location.href);
  const keys = [
    "token_hash",
    "type",
    "next",
    "code",
    "error",
    "error_code",
    "error_description",
    "error_link_type",
  ];
  let changed = false;
  for (const key of keys) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (/access_token|refresh_token|error_description|error=|token_hash/.test(url.hash)) {
    url.hash = "";
    changed = true;
  }
  let path = url.pathname;
  if (path === "/auth/confirm" || path.startsWith("/auth/")) {
    path = "/";
    changed = true;
  }
  if (!changed) return;
  const search = url.searchParams.toString();
  history.replaceState({}, "", path + (search ? `?${search}` : "") + url.hash);
}

/**
 * Confirm-signup emails often land on /auth/confirm?token_hash=… (or /?code=…).
 * Exchange the token here so the user is signed in on this static app.
 */
async function consumeEmailAuthCallback(supabase) {
  const { get } = readAuthCallbackParams();
  const errorCode = get("error") || get("error_code");
  const errorDescription = get("error_description");
  if (errorCode || errorDescription) {
    window.__oneweekAuthCallbackError = friendlyAuthCallbackError(
      errorDescription || errorCode
    );
    stripAuthCallbackFromAddress();
    return;
  }

  const tokenHash = get("token_hash");
  const typeRaw = get("type");
  if (tokenHash) {
    const type = EMAIL_OTP_TYPES.has(typeRaw) ? typeRaw : "email";
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });
    if (error) {
      window.__oneweekAuthCallbackError = friendlyAuthCallbackError(
        error.message
      );
    }
    stripAuthCallbackFromAddress();
  }
}

/**
 * Single auth subscription for the app. Workspaces load first, then panel
 * listeners run — avoids each panel calling getSession + onAuthStateChange.
 */
const ONEWEEK_AUTH_CHANGE = "oneweek-auth-change";

(function setupOneweekAuthHub() {
  if (typeof window === "undefined" || window.oneweekAuth) return;
  const supabase = window.supabaseClient;
  if (!supabase) return;

  let session = null;
  let initialized = false;
  const listeners = new Set();
  let chain = Promise.resolve();

  let lastUserId = null;

  async function publish(nextSession) {
    session = nextSession ?? null;
    const userId = session?.user?.id ?? null;
    // Session ended or switched user (expiry, logout in another tab): the
    // previous user's plaintext task caches must not stay on the device.
    if (lastUserId && lastUserId !== userId) clearAllTasksCaches();
    lastUserId = userId;
    try {
      await window.oneweekWorkspaces.applyAuthSession(session);
    } catch (err) {
      console.error("Workspace auth apply failed:", err);
    }
    for (const fn of [...listeners]) {
      try {
        await fn(session);
      } catch (err) {
        console.error("Auth listener failed:", err);
      }
    }
    window.dispatchEvent(
      new CustomEvent(ONEWEEK_AUTH_CHANGE, { detail: { session } })
    );
  }

  function enqueue(nextSession) {
    chain = chain.then(() => publish(nextSession)).catch((err) => {
      console.error("Auth hub publish failed:", err);
    });
    return chain;
  }

  window.oneweekAuth = {
    getSession: () => session,
    isReady: () => initialized,
    whenReady: () => readyPromise,
    subscribe(fn) {
      listeners.add(fn);
      if (initialized) void fn(session);
      return () => listeners.delete(fn);
    },
  };

  // Subscribe before async init so sign-in/out during startup is not missed.
  let authEventsSeen = 0;
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    authEventsSeen += 1;
    void enqueue(nextSession);
  });

  const readyPromise = (async () => {
    try {
      const hadAuthCode =
        new URLSearchParams(window.location.search).has("code") ||
        /(?:^|[&#])code=/.test(window.location.hash);

      await consumeEmailAuthCallback(supabase);

      const { data } = await supabase.auth.getSession();
      if (
        hadAuthCode &&
        !data?.session &&
        !window.__oneweekAuthCallbackError
      ) {
        window.__oneweekAuthCallbackError =
          "Couldn't finish signing in from this link. Open it on the same device you used to create the account, or create the account again.";
      }
      stripAuthCallbackFromAddress();
      if (authEventsSeen === 0) {
        await enqueue(data?.session ?? null);
      }
    } catch (err) {
      console.error("Auth hub init failed:", err);
      if (authEventsSeen === 0) {
        await enqueue(null);
      }
    } finally {
      initialized = true;
    }
  })();
})();

async function logout() {
  const supabase = window.supabaseClient;
  if (!supabase) {
    console.error("Supabase client missing.");
    return { ok: false, error: "Auth client not initialized." };
  }

  // Drop focus so a still-typed value isn't lost when DOM is wiped after sign out.
  const active = document.activeElement;
  if (active && typeof active.blur === "function") active.blur();

  // Persist anything that's still in-flight before the session goes away.
  try {
    await flushAllTaskSaves();
  } catch (err) {
    console.error("Pre-logout flush failed:", err);
  }

  // Edits that still could not reach the server live only in this device's
  // cache, which logging out clears.
  if (
    hasUnsyncedTaskEdits() &&
    !window.confirm("Some changes haven't synced yet and will be lost if you log out now. Log out anyway?")
  ) {
    return { ok: false, cancelled: true };
  }

  let { error } = await supabase.auth.signOut();
  if (error && isLikelyNetworkError(error)) {
    // Offline: the server can't end the session now; forget it on this device.
    ({ error } = await supabase.auth.signOut({ scope: "local" }));
  }
  if (error) {
    console.error("Sign out failed:", error);
    return { ok: false, error: "Logout failed." };
  }
  clearAllTasksCaches();
  return { ok: true };
}

/**
 * Guest auth modal — full-screen blurred overlay shown when the user has no
 * Supabase session. Separate Sign in and Create account actions; wrong
 * password never triggers an automatic sign-up attempt.
 */
(function setupGuestAuthModal() {
  const backdrop = document.getElementById("guest-auth-backdrop");
  const form = document.getElementById("guest-auth-form");
  const emailInput = document.getElementById("guest-auth-email");
  const passwordInput = document.getElementById("guest-auth-password");
  const signInBtn = document.getElementById("guest-auth-signin");
  const signUpBtn = document.getElementById("guest-auth-signup");
  const messageEl = document.getElementById("guest-auth-message");
  const messageSlot = document.getElementById("guest-auth-message-slot");
  const appMain = document.getElementById("app-main");
  if (!backdrop || !form || !emailInput || !passwordInput || !signInBtn || !signUpBtn) {
    return;
  }

  const supabase = window.supabaseClient;
  if (!supabase) return;

  function setMessage(text, isError = false) {
    if (!messageEl) return;
    messageEl.textContent = text || "";
    messageEl.classList.toggle("is-error", !!isError && !!text);
    if (messageSlot) messageSlot.classList.toggle("is-shown", !!text);
  }

  function setPending(isPending) {
    signInBtn.disabled = isPending;
    signUpBtn.disabled = isPending;
    emailInput.disabled = isPending;
    passwordInput.disabled = isPending;
    signInBtn.textContent = isPending ? "..." : "Sign in";
    signUpBtn.textContent = isPending ? "..." : "Create account";
  }

  function getGuestFocusables() {
    return [emailInput, passwordInput, signInBtn, signUpBtn].filter(
      (el) => el && !el.disabled
    );
  }

  /** Block task editing while guest auth is open; keep header menu reachable. */
  function setGuestBlockingInert(inert) {
    const tasksField = document.getElementById("tasks-field");
    const weekPanel = document.querySelector(".week-panel");
    const weekNav = document.querySelector(".layout-header-week");
    const headerRight = document.querySelector(".layout-header-right");
    if (tasksField) tasksField.inert = !!inert;
    if (weekPanel) weekPanel.inert = !!inert;
    if (weekNav) weekNav.inert = !!inert;
    if (headerRight) headerRight.inert = !!inert;
    if (appMain) appMain.removeAttribute("inert");
  }

  function trapGuestFocus(e) {
    if (backdrop.hidden) return;
    if (e.key !== "Tab") return;
    const focusables = getGuestFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!backdrop.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  function onGuestKeydown(e) {
    if (backdrop.hidden) return;
    // Blocking auth: Escape must not dismiss. Still swallow so it doesn't
    // hit other UI behind the inert main.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function show() {
    if (!backdrop.hidden) return;
    backdrop.hidden = false;
    setGuestBlockingInert(true);
    requestAnimationFrame(() => emailInput.focus({ preventScroll: true }));
  }

  window.oneweekOpenGuestAuth = () => {
    if (!backdrop.hidden) {
      requestAnimationFrame(() => emailInput.focus({ preventScroll: true }));
      return;
    }
    show();
  };

  function hide() {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    setGuestBlockingInert(false);
    setMessage("");
    setPending(false);
    form.reset();
  }

  function looksLikeUnconfirmedEmail(error) {
    const msg = String(error?.message || error || "").toLowerCase();
    return msg.includes("email not confirmed") || msg.includes("not confirmed");
  }

  function showConfirmEmailMessage(email) {
    const target = email ? ` to ${email}` : "";
    setMessage(
      `We sent a confirmation link${target}. Open it to finish signing in.`
    );
  }

  function readCredentials() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      setMessage("Enter your email and password.", true);
      return null;
    }
    return { email, password };
  }

  async function handleSignIn(e) {
    e.preventDefault();
    const creds = readCredentials();
    if (!creds) return;

    setPending(true);
    setMessage("Signing in...");

    const { error: signInError } = await supabase.auth.signInWithPassword(creds);

    if (!signInError) {
      setMessage("");
      setPending(false);
      return;
    }

    if (looksLikeUnconfirmedEmail(signInError)) {
      try {
        await supabase.auth.resend({
          type: "signup",
          email: creds.email,
          options: { emailRedirectTo: getAuthEmailRedirectTo() },
        });
      } catch (_) {
        /* best-effort */
      }
      setPending(false);
      showConfirmEmailMessage(creds.email);
      return;
    }

    setPending(false);
    setMessage(signInError.message || "Wrong email or password.", true);
  }

  async function handleSignUp() {
    const creds = readCredentials();
    if (!creds) return;

    setPending(true);
    setMessage("Creating account...");

    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: creds.email,
      password: creds.password,
      options: { emailRedirectTo: getAuthEmailRedirectTo() },
    });

    setPending(false);

    if (signUpError) {
      setMessage(signUpError.message || "Couldn't create account.", true);
      return;
    }

    if (signUpData?.session) {
      setMessage("");
      return;
    }
    showConfirmEmailMessage(creds.email);
  }

  form.addEventListener("submit", handleSignIn);
  signUpBtn.addEventListener("click", () => {
    void handleSignUp();
  });
  backdrop.addEventListener("keydown", trapGuestFocus);
  document.addEventListener("keydown", onGuestKeydown, true);

  async function applySession(session) {
    if (session?.user) {
      hide();
      return;
    }
    show();
    const callbackError = window.__oneweekAuthCallbackError;
    if (callbackError) {
      setMessage(callbackError, true);
    }
  }

  window.oneweekAuth.subscribe((session) => {
    void applySession(session);
  });
})();
