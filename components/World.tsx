"use client";

import { useEffect, useRef, useState } from "react";
import type { World, WorldCompany } from "@/lib/types";

const LOGO_PX = 16;

/**
 * A company logo in the DS's pixel style: drawn into a 16x16 canvas (via our same-origin /api/logo copy) and shown 2x with
 * hard pixels. Its brightness picks the tile: light logos get an ink tile so they don't vanish. Falls back to the initial.
 */
function PixelLogo({ company }: { company: WorldCompany }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "light" | "dark" | "failed">(company.logo ? "loading" : "failed");
  useEffect(() => {
    if (!company.logo) return;
    const image = new Image();
    image.onload = () => {
      const context = canvas.current?.getContext("2d", { willReadFrequently: true });
      if (!context || !image.width || !image.height) return setState("failed");
      const fit = Math.min(LOGO_PX / image.width, LOGO_PX / image.height);
      const [w, h] = [Math.max(1, Math.round(image.width * fit)), Math.max(1, Math.round(image.height * fit))];
      context.clearRect(0, 0, LOGO_PX, LOGO_PX);
      context.imageSmoothingEnabled = true;
      context.drawImage(image, Math.floor((LOGO_PX - w) / 2), Math.floor((LOGO_PX - h) / 2), w, h);
      // Average brightness of the visible pixels decides the tile.
      const data = context.getImageData(0, 0, LOGO_PX, LOGO_PX).data;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        count++;
      }
      setState(count && sum / count > 0.78 ? "light" : "dark");
    };
    image.onerror = () => setState("failed");
    image.src = `/api/logo?u=${encodeURIComponent(company.logo)}`;
  }, [company.logo]);
  return (
    <span className={`world-logo ${state === "light" ? "world-logo-dark" : ""}`} aria-hidden>
      {state === "failed" ? <b>{company.name.slice(0, 1)}</b> : <canvas ref={canvas} className="mascot world-logo-pixels" width={LOGO_PX} height={LOGO_PX} />}
    </span>
  );
}

/** "1.2k", "58k": a compact star count. */
export function starCount(stars: number) {
  return stars >= 1000 ? `${(stars / 1000).toFixed(stars >= 10_000 ? 0 : 1)}k` : String(stars);
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** A short link label: the page title (search results come as Google redirect links, whose host says nothing). */
const label = (source: { title: string; url: string }) => {
  const text = source.title && source.title !== source.url ? source.title : host(source.url);
  return text;
};

/**
 * How this change reaches the world: a quoted headline, who uses it (REACH), what the change means for them, the companies
 * as a compact logo grid (notes on hover) and a tidy source list. Logos sit on neutral tiles (brand reds and greens would
 * clash with Red and Green); light-coloured logos get a dark tile so they don't vanish.
 */
export function WorldCard({ world, title }: { world: World; title: string }) {
  return (
    <section className="world" aria-label={title}>
      <span className="world-title">{title}</span>
      {world.headline && <p className="world-headline">{world.headline}</p>}
      {world.reach && (
        <div className="world-fact">
          <span className="world-label">REACH</span>
          <p>{world.reach}</p>
        </div>
      )}
      {world.impact && (
        <div className="world-fact">
          <span className="world-label">WHAT IT MEANS</span>
          <p>{world.impact}</p>
        </div>
      )}
      {world.companies.length > 0 && (
        <ul className="world-companies">
          {world.companies.map((company) => (
            <li key={company.domain} title={company.note || company.description}>
              <PixelLogo company={company} />
              <span className="world-company">
                <strong>{company.name}</strong>
                <small>{company.role === "maker" ? "makes it" : "uses it"}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      {world.sources.length > 0 && (
        <div className="world-fact">
          <span className="world-label">SOURCES</span>
          <ul className="world-sources">
            {world.sources.map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer" title={source.title}>
                  ↗ {label(source)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
