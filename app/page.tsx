import { HomeDS } from "@/components/HomeDS";
import { listJobs } from "@/lib/jobs";
import { listPuzzles } from "@/lib/puzzles";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [puzzles, jobs] = await Promise.all([
    listPuzzles().catch((error: unknown) => {
      console.error("Could not list puzzles", error);
      return [];
    }),
    listJobs(),
  ]);
  return (
    <HomeDS
      puzzles={puzzles.map(({ id, title, pr, component, musicFile, bpm, family, families }) => ({ id, title, pr, component, musicFile, bpm, family, families }))}
      jobs={jobs}
    />
  );
}
