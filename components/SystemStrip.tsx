import type { SystemStage } from "@/lib/puzzles";

/** The whole system as a chain of stages, with the changed one marked. */
export function SystemStrip({ stages }: { stages: SystemStage[] }) {
  return (
    <ol className="system" aria-label="How the whole thing fits together">
      {stages.map((stage) => (
        <li key={stage.name} className={stage.changed ? "stage-changed" : undefined} title={stage.role}>
          <span aria-hidden>{stage.emoji}</span>
          <span>{stage.name}</span>
          {stage.changed && <small>changed</small>}
        </li>
      ))}
    </ol>
  );
}
