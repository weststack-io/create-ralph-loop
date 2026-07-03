import type { RalphConfig } from "../config/schema";
import type { RunState } from "../run/state";
import type { BudgetEvent, StallEvent } from "../events/types";
import { nowIso } from "../events/types";

/**
 * Budget + stall evaluation. Pure functions over run state so they are trivially
 * testable; the loop applies the decisions (append events, notify, halt).
 */

export interface BudgetDecision {
  halt: boolean;
  reason?: string;
  events: BudgetEvent[];
}

function budgetEvent(
  metric: BudgetEvent["metric"],
  spent: number,
  limit: number,
  halted: boolean,
): BudgetEvent {
  return { type: "budget", ts: nowIso(), metric, spent, limit, halted };
}

/**
 * Check hard budgets. effectiveMaxIterations is the CLI override or config value
 * (0/undefined = unlimited). Returns halt=true with a reason once any budget is
 * exhausted.
 */
export function checkBudget(
  state: RunState,
  config: RalphConfig,
  effectiveMaxIterations: number | undefined,
  elapsedMs: number,
): BudgetDecision {
  const events: BudgetEvent[] = [];

  if (effectiveMaxIterations && state.iteration >= effectiveMaxIterations) {
    events.push(budgetEvent("iterations", state.iteration, effectiveMaxIterations, true));
    return { halt: true, reason: `iteration budget reached (${effectiveMaxIterations})`, events };
  }

  const maxCost = config.budgets.maxCostUsd;
  if (maxCost && state.totalCostUsd >= maxCost) {
    events.push(budgetEvent("cost", round(state.totalCostUsd), maxCost, true));
    return { halt: true, reason: `cost budget reached ($${maxCost})`, events };
  }

  const maxMin = config.budgets.maxWallClockMinutes;
  if (maxMin && elapsedMs >= maxMin * 60_000) {
    events.push(budgetEvent("time", round(elapsedMs / 60_000), maxMin, true));
    return { halt: true, reason: `time budget reached (${maxMin} min)`, events };
  }

  return { halt: false, events };
}

export interface StallDecision {
  stalled: boolean;
  halt: boolean;
  event?: StallEvent;
}

/**
 * Detect lack of progress. At `noProgressIterations` we notify; at 2x we halt to
 * cap runaway spend when the loop is thrashing on unblockable work.
 */
export function checkStall(state: RunState, config: RalphConfig): StallDecision {
  const gap = state.iteration - state.lastProgressIteration;
  const threshold = config.stall.noProgressIterations;
  if (threshold <= 0) return { stalled: false, halt: false };

  if (gap >= threshold * 2) {
    return { stalled: true, halt: true, event: stallEvent(gap, "halt") };
  }
  if (gap >= threshold) {
    return { stalled: true, halt: false, event: stallEvent(gap, "notify") };
  }
  return { stalled: false, halt: false };
}

function stallEvent(gap: number, action: StallEvent["action"]): StallEvent {
  return { type: "stall", ts: nowIso(), iterationsWithoutProgress: gap, action };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
