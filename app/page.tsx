import { HomeDS } from "@/components/HomeDS";
import { listPuzzles } from "@/lib/puzzles";

export const dynamic = "force-dynamic";

export default async function Home() {
  const puzzles = await listPuzzles().catch((error: unknown) => {
    console.error("Could not list puzzles", error);
    return [];
  });
  return <HomeDS puzzles={puzzles.map(({ id, title, pr, component, musicFile, bpm }) => ({ id, title, pr, component, musicFile, bpm }))} />;
}
