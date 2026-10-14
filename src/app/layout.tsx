import type { ReactNode } from "react";

export const metadata = { title: "PPEC transportation dashboard" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <div role="status" style={{ background: "#b45309", color: "#fff", padding: "4px 12px", fontWeight: 600 }}>
          SYNTHETIC DATA: demo only, no real children or families
        </div>
        {children}
      </body>
    </html>
  );
}
