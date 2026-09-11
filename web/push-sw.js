/**
 * Web Push Service Worker (Camada B: all tabs closed).
 *
 * Vanilla, no bundle: copied as-is to dist/ by build.ts. Renders turn-end
 * pushes as OS notifications; click opens (or focuses) the Indirect Code
 * page. Payload is display-only ({title, body, url, tag}) — never secrets.
 */

/* eslint-disable no-undef */
declare const self: ServiceWorkerGlobalScope;

self.addEventListener("push", (event) => {
  let data = { title: "Turn finished", body: "Your agent replied", url: "/#/code", tag: "turn" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: "/indirect-icon.svg",
      badge: "/indirect-icon.svg",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/#/code";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        try {
          if ("focus" in w) {
            await (w as WindowClient).focus();
            if ("navigate" in w) await (w as WindowClient).navigate(url);
            return;
          }
        } catch {}
      }
      try {
        await self.clients.openWindow(url);
      } catch {}
    })(),
  );
});
