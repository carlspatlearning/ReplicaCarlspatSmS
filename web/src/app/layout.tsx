import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Samen International School", template: "%s · Samen International School" },
  description:
    "Samen International School Management System — Portal for parents, students, teachers, and staff.",
  applicationName: "Samen International School",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/samen-logo.png?v=4", type: "image/png" }],
    apple: [{ url: "/samen-logo.png?v=4", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1e3a5f",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
