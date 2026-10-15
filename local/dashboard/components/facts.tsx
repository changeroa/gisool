import type { FindingLabel } from "../../src/types.js";
import { FINDING_LABEL, FINDING_TITLE } from "../state";
import { UNKNOWN, formatCostUsd, formatLapse } from "./calls";

// One line of reported facts, as the Workspaces view and the session trace both print them.
// A fact is the measurement, not its sentence: the builders return keys and numbers, this module turns them into
// words. Wording can change here without touching a caller or a test, and a count of null stays "unknown".

export type Fact =
  | { key: "workspace" | "tab"; value: string }
  | { key: "panes" | "sessions" | "inferred" | "unlinked" | "turns" | "found" | "abstained"; value: number }
  | { key: "calls" | "callsAfter" | "gisoolCalls" | "failed" | "reads"; value: number }
  | { key: "spans"; acted: number; total: number }
  /** A measurement the runtime never reported is null here and reads "unknown", never 0. */
  | { key: "cost" | "active"; value: number | null }
  | { key: "finding"; value: FindingLabel };

export type FactKey = Fact["key"];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function factText(fact: Fact): string {
  switch (fact.key) {
    case "workspace": return fact.value;
    case "tab": return `tab ${fact.value}`;
    case "panes": return plural(fact.value, "pane", "panes");
    case "sessions": return plural(fact.value, "session", "sessions");
    case "inferred": return `${fact.value} inferred`;
    case "unlinked": return `${fact.value} unlinked`;
    case "turns": return plural(fact.value, "turn", "turns");
    case "found": return `${fact.value} found via search`;
    case "abstained": return `${fact.value} abstained`;
    case "calls": return plural(fact.value, "call", "calls");
    case "callsAfter": return `${plural(fact.value, "call", "calls")} after activation`;
    case "gisoolCalls": return `${plural(fact.value, "call", "calls")} to gisool`;
    case "failed": return `${fact.value} failed`;
    case "reads": return `${plural(fact.value, "read", "reads")} of its resources`;
    case "spans": return `${fact.acted}/${fact.total} ${fact.total === 1 ? "span" : "spans"} acted`;
    case "cost": return `cost ${fact.value === null ? UNKNOWN : formatCostUsd(fact.value)}`;
    case "active": return `active ${formatLapse(fact.value)}`;
    case "finding": return FINDING_LABEL[fact.value];
    default: {
      const exhaustive: never = fact;
      return String(exhaustive);
    }
  }
}

export function factTitle(fact: Fact): string | undefined {
  return fact.key === "finding" ? FINDING_TITLE[fact.value] : undefined;
}

export function Facts({ facts, className = "facts" }: { facts: Fact[]; className?: string }) {
  return (
    <p class={className}>
      {facts.map((fact, index) => (
        <span key={`${fact.key}-${index}`} class="facts__item" data-fact={fact.key} title={factTitle(fact)}>
          {factText(fact)}
        </span>
      ))}
    </p>
  );
}
