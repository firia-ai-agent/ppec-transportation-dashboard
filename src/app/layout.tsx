import type { ReactNode } from "react";
import { Atkinson_Hyperlegible_Next, JetBrains_Mono } from "next/font/google";
import { DemoBar } from "@/ui/DemoBar";
import { app } from "@/ui/copy";
import { tokenCss } from "@/ui/tokens";
import "./globals.css";

/**
 * D-4 / §2: Atkinson Hyperlegible Next for UI and numerals (designed for low-vision
 * legibility), JetBrains Mono for ids only. Both are in next/font/google, so they are
 * self-hosted at build time — no runtime request to Google.
 */
const ui = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-ui",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata = { title: app.documentTitle };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable}`}>
      <head>
        {/* Every design token, from src/ui/tokens.ts, as CSS custom properties. */}
        <style>{tokenCss()}</style>
      </head>
      <body>
        {/* §7 / §7.1 / NFR-09: the DEMO bar, carrying the source-mode chip and the demo's one
            control, above everything and on every route including /login. */}
        <DemoBar />
        {children}
      </body>
    </html>
  );
}
