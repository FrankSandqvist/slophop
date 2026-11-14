import type { Metadata, Viewport } from "next";
import { STYLE, tokensCss } from "@/lib/style";
import "./globals.css";

export const metadata: Metadata = {
  title: "SlopHop — puzzles for humans, reviews for robots",
  description: "Logic puzzles generated from real pull requests. Crack the puzzle, and you've reviewed the code. No coding required.",
};

export const viewport: Viewport = { themeColor: STYLE.tokens["--sh-bg"] };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={STYLE.fontsHref} />
        <style id="slophop-tokens">{tokensCss()}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
