import "server-only";
import { MODELS, generateJson } from "./gemini";
import type { PullRequestSource } from "./github";
import type { World, WorldCompany } from "./types";

/**
 * "How does this affect the world": Gemini researches the project with Google Search (who makes it, who uses it, how
 * widely, what this change means for them), then context.dev adds each company's logo, colour and description.
 * Runs alongside the modelling and everything fails gently: no research, no enrichment, never a broken puzzle.
 */

const RESEARCH_MS = Number(process.env.WORLD_RESEARCH_MS || 45_000);
const ENRICH_MS = 8_000;

const schema = {
  type: "object",
  properties: {
    headline: { type: "string", description: "How this change reaches real people, one plain punchy line, max 16 words." },
    reach: {
      type: "string",
      description: "Who uses this project and how widely, with concrete numbers you found (users, downloads, installs, stars, companies). Plain words, max 35 words.",
    },
    impact: { type: "string", description: "What THIS change means for those people in practice: what they'd notice or what it prevents. Plain words, max 35 words." },
    companies: {
      type: "array",
      description: "Up to 3 real organisations: the one that makes the project (if any) and well-known ones that use it. Only ones your search results support.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Organisation name." },
          domain: { type: "string", description: "Its main website domain, e.g. 'netflix.com'." },
          role: { type: "string", enum: ["maker", "user"], description: "maker = builds/maintains the project; user = runs it." },
          note: { type: "string", description: "How it relates to the project, plain words, max 12 words." },
        },
        required: ["name", "domain", "role", "note"],
      },
    },
    sources: {
      type: "array",
      description: "Up to 4 web pages from your search results that back this up.",
      items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } }, required: ["title", "url"] },
    },
  },
  required: ["headline", "reach", "impact", "companies", "sources"],
};

type Research = Omit<World, "companies"> & { companies: Array<Pick<WorldCompany, "name" | "domain" | "role" | "note">> };

function prompt(pr: PullRequestSource) {
  return `SlopHop turns real code changes into small puzzles for curious people. We want to show players how this change
reaches the real world. Use Google Search to find out:
- what this project is and who makes it (a company, a foundation, volunteers?)
- who uses it and how widely: concrete numbers (users, downloads, installs, stars, apps or companies built on it)
- what THIS change means in practice for those people
Name up to 3 real organisations (the maker, and well-known users) only when your search results support it.
If the project is small or personal, say so honestly; don't inflate it. Plain words, no jargon.

PROJECT: ${pr.repository}${pr.stars ? ` (${pr.stars.toLocaleString("en-US")} GitHub stars)` : ""}
${pr.repoDescription ? `DESCRIPTION: ${pr.repoDescription}\n` : ""}${pr.homepage ? `HOMEPAGE: ${pr.homepage}\n` : ""}THE CHANGE: ${pr.title}
${pr.body.slice(0, 900)}`;
}

const DOMAIN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** context.dev brand lookup by domain: logo, main colour, short description, industry. Null on any failure (unknown = 400, not charged). */
async function brand(domain: string) {
  const key = process.env.CONTEXT_DEV_KEY;
  if (!key || !DOMAIN.test(domain)) return null;
  try {
    const response = await fetch("https://api.context.dev/v1/brand/retrieve", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "by_domain", domain }),
      signal: AbortSignal.timeout(ENRICH_MS),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      brand?: {
        title?: string;
        description?: string;
        colors?: Array<{ hex?: string }>;
        logos?: Array<{ url?: string; type?: string; mode?: string }>;
        industries?: { eic?: Array<{ industry?: string }> };
      };
    };
    const found = json.brand;
    if (!found) return null;
    const logos = found.logos ?? [];
    // Prefer an icon made for light backgrounds (our tiles are light); otherwise any icon or logo, remembering its mode.
    const chosen = logos.find((entry) => entry.type === "icon" && entry.mode === "light") ?? logos.find((entry) => entry.mode === "light") ?? logos.find((entry) => entry.type === "icon") ?? logos[0];
    const logo = chosen?.url;
    return {
      ...(logo && /^https:\/\//.test(logo) ? { logo, ...(chosen?.mode ? { logoMode: chosen.mode } : {}) } : {}),
      ...(found.colors?.[0]?.hex && /^#[0-9a-f]{6}$/i.test(found.colors[0].hex) ? { color: found.colors[0].hex } : {}),
      ...(found.description ? { description: found.description.slice(0, 160) } : {}),
      ...(found.industries?.eic?.[0]?.industry ? { industry: found.industries.eic[0].industry } : {}),
    };
  } catch {
    return null;
  }
}

export async function researchWorld(pr: PullRequestSource, signal?: AbortSignal): Promise<World | null> {
  try {
    const timeout = AbortSignal.timeout(RESEARCH_MS);
    const { data, citations } = await generateJson<Research>({
      model: MODELS.backup,
      prompt: prompt(pr),
      schema,
      tools: [{ type: "google_search" }],
      thinking: "low",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      fallbacks: [],
    });
    const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
    const seen = new Set<string>();
    const companies = (data.companies ?? [])
      .map((company) => ({
        name: text(company?.name, 60),
        domain: text(company?.domain, 80).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
        role: (company?.role === "maker" ? "maker" : "user") as WorldCompany["role"],
        note: text(company?.note, 100),
      }))
      .filter((company) => company.name && DOMAIN.test(company.domain) && !seen.has(company.domain) && seen.add(company.domain))
      .slice(0, 3);
    const enriched = await Promise.all(companies.map(async (company) => ({ ...company, ...((await brand(company.domain)) ?? {}) })));
    const sources = [...citations, ...(data.sources ?? [])]
      .filter((source) => /^https?:\/\//.test(String(source?.url ?? "")))
      .filter((source, index, list) => list.findIndex((other) => other.url === source.url) === index)
      .slice(0, 4)
      .map((source) => ({ title: text(source.title, 80) || source.url, url: text(source.url, 300) }));
    const world: World = { headline: text(data.headline, 140), reach: text(data.reach, 260), impact: text(data.impact, 260), companies: enriched, sources };
    return world.reach || world.impact ? world : null;
  } catch (error) {
    console.warn("World research failed (puzzle continues without it)", error instanceof Error ? error.message : error);
    return null;
  }
}
