/**
 * Web Push Service Worker (Camada B: all tabs closed).
 *
 * Plain JavaScript on purpose: copied as-is to dist/ by build.ts with NO
 * transpiler step, so no TypeScript syntax (declare/as/annotations) is
 * allowed here — the browser parses it raw. Renders turn-end pushes as OS
 * notifications; click opens (or focuses) the Indirect Code page. Payload
 * is display-only ({title, body, url, tag}) — never secrets.
 */

/* eslint-disable no-undef */
self.addEventListener("push", (event) => {
  let data = { title: "Turn finished", body: "Your agent replied", url: "/#/code", tag: "turn" };
  try {
    if (event.data) data = Object.assign({}, data, event.data.json());
  } catch (e) {}
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
  const ndata = event.notification.data || {};
  const url = ndata.url || "/#/code";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        try {
          if (typeof w.focus === "function") {
            await w.focus();
            if (typeof w.navigate === "function") await w.navigate(url);
            return;
          }
        } catch (e) {}
      }
      try {
        await self.clients.openWindow(url);
      } catch (e) {}
    })(),
  );
});
