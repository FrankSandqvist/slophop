import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SlopHop",
  description: "Learn the logic that runs the world, see how it's changing, and weigh in. Real AI-made code changes as tiny puzzles, starring Green (new code) and Red (old code).",
};

export const viewport: Viewport = { themeColor: "#ffcf33", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router root layout: loads for every page */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DotGothic16&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
