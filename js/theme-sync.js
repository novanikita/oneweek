/**
 * Theme sync — keeps the selected theme and custom themes the same on every
 * device of the signed-in user (`public.user_settings`).
 *
 * localStorage stays the source for the first paint (theme-init.js runs before
 * auth). The newer side wins by `theme_updated_at`: on sign-in and when the
 * network returns we pull, and push instead when this device is newer; local
 * changes are pushed shortly after they happen.
 */
(() => {
  const supabase = window.supabaseClient;
  const theme = window.oneweekTheme;
  const auth = window.oneweekAuth;
  if (!supabase || !theme || !auth) return;

  const PUSH_DELAY_MS = 600;
  let userId = null;
  let pushTimer = null;

  function timeOf(iso) {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : 0;
  }

  async function push() {
    if (!userId) return;
    let updatedAt = theme.getThemeUpdatedAt();
    if (!updatedAt) {
      updatedAt = new Date().toISOString();
      theme.setThemeUpdatedAt(updatedAt);
    }
    const selected = theme.getSelectedThemeKey();
    const { error } = await supabase.from("user_settings").upsert({
      user_id: userId,
      theme_selected: selected === theme.OWN_THEME_KEY ? null : selected,
      custom_themes: theme.getCustomThemes(),
      theme_updated_at: updatedAt,
    });
    if (error) {
      markNetworkFailure(error);
      console.error("Theme settings save failed:", error);
      return;
    }
    markNetworkSuccess();
  }

  async function pull() {
    if (!userId) return;
    const requestedFor = userId;
    const { data, error } = await supabase
      .from("user_settings")
      .select("theme_selected, custom_themes, theme_updated_at")
      .eq("user_id", requestedFor)
      .maybeSingle();
    if (error) {
      markNetworkFailure(error);
      console.error("Theme settings load failed:", error);
      return;
    }
    markNetworkSuccess();
    if (requestedFor !== userId) return;

    const localAt = theme.getThemeUpdatedAt();
    if (data && timeOf(data.theme_updated_at) > timeOf(localAt)) {
      theme.applyRemoteThemeSettings({
        selected: data.theme_selected,
        customThemes: data.custom_themes,
        updatedAt: data.theme_updated_at,
      });
      return;
    }
    if (!data || timeOf(localAt) > timeOf(data.theme_updated_at)) {
      await push();
    }
  }

  function schedulePush() {
    if (!userId) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void push();
    }, PUSH_DELAY_MS);
  }

  auth.subscribe((session) => {
    const nextUserId = session?.user?.id ?? null;
    if (nextUserId === userId) return;
    userId = nextUserId;
    clearTimeout(pushTimer);
    if (userId) void pull();
  });

  window.addEventListener(theme.THEME_LOCAL_CHANGE, schedulePush);
  onNetworkRetry(() => pull());
})();
