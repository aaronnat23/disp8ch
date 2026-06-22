import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/layout/providers";

export const metadata: Metadata = {
  title: "disp8ch - AI Workflow Builder",
  description: "Personal AI assistant with visual workflow editor",
  manifest: "/manifest.webmanifest",
  applicationName: "disp8ch",
  appleWebApp: {
    capable: true,
    title: "disp8ch",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: "/logo.png",
    apple: "/pwa-icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#08090f",
};

const themeInitScript = `
(function () {
  try {
    var theme = localStorage.getItem("disp8ch-theme") || "dark";
    if (theme === "light") document.documentElement.classList.remove("dark");
    else document.documentElement.classList.add("dark");
  } catch (_) {
    document.documentElement.classList.add("dark");
  }
})();
`;

const swRegistrationScript = process.env.NODE_ENV === "development"
  ? `
(function () {
  if (!('serviceWorker' in navigator)) return;

  var resetKey = 'disp8ch-dev-sw-reset-v2';
  var registrations = navigator.serviceWorker.getRegistrations()
    .then(function (items) {
      return Promise.all(items.map(function (registration) {
        return registration.unregister();
      })).then(function () { return items.length > 0; });
    });
  var cachedShells = 'caches' in window
    ? caches.keys().then(function (keys) {
        var disp8chKeys = keys.filter(function (key) { return key.indexOf('disp8ch-') === 0; });
        return Promise.all(disp8chKeys.map(function (key) { return caches.delete(key); }))
          .then(function () { return disp8chKeys.length > 0; });
      })
    : Promise.resolve(false);

  Promise.all([registrations, cachedShells]).then(function (results) {
    if ((results[0] || results[1]) && sessionStorage.getItem(resetKey) !== '1') {
      sessionStorage.setItem(resetKey, '1');
      window.location.reload();
    }
  }).catch(function () {});
})();
`
  : `
(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then(function (registration) { return registration.update(); })
      .catch(function () {});
  });
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-mono antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <script dangerouslySetInnerHTML={{ __html: swRegistrationScript }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
