/**
 * Google Identity Services loader + button renderer (official GSI button —
 * the safest way to obtain an ID token, and required by Google's rules).
 * Loaded lazily; themed to match the app (dark pill on the dark theme,
 * outlined pill on light) and re-rendered when the theme flips.
 */

declare global {
  interface Window {
    google?: any;
    __gsiPromise?: Promise<void>;
  }
}

function loadGsi(): Promise<void> {
  if (window.__gsiPromise) return window.__gsiPromise;
  window.__gsiPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("failed to load Google sign-in"));
    document.head.appendChild(script);
  });
  return window.__gsiPromise;
}

export async function renderGoogleButton(
  el: HTMLElement,
  clientId: string,
  onCredential: (idToken: string) => void,
): Promise<void> {
  await loadGsi();
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: (response: { credential: string }) => onCredential(response.credential),
    ux_mode: "popup",
    auto_select: false,
  });
  const render = () => {
    el.innerHTML = "";
    window.google.accounts.id.renderButton(el, {
      theme:
        document.documentElement.dataset.theme === "dark"
          ? "filled_black"
          : "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      width: 300,
    });
  };
  render();
  // Follow theme toggles (same observer pattern as the favicon sync).
  new MutationObserver(render).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}
