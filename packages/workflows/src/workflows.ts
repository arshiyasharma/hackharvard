/**
 * The durable part: Mastra workflows whose runs persist in storage (Postgres in production), so a deal that is
 * waiting on a buyer, an owner decision or a hand-off survives a redeploy, and so does a move's Last Call timer.
 * Steps do no business logic themselves: they hand the event to the engine's dispatcher and suspend again until
 * the deal leaves their stage.
 */
import { Mastra } from "@mastra/core";
import type { MastraStorage } from "@mastra/core/storage";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { Deal, DealEvent, DealStage } from "./types.ts";

export interface WorkflowDeps {
  /** Apply one event to a deal (policy + persistence + effects) and return the updated deal. */
  dispatch: (dealId: string, event: DealEvent) => Promise<Deal>;
  /** Fire one Last Call stage for a move (prices, texts, events). */
  fireLastCall: (moveId: string, stage: "drop" | "free" | "close") => Promise<void>;
}

const StageIO = z.object({ dealId: z.string(), status: z.string(), stage: z.string() });
export type StageIO = z.infer<typeof StageIO>;
const Event = z.object({ kind: z.string() }).loose();

const ORDER: Record<string, number> = { negotiating: 0, scheduling: 1, handoff: 2, done: 3 };
const stageIndex = (s: string) => ORDER[s] ?? 3;
const awaitingFor: Record<DealStage, string> = {
  negotiating: "buyer offer or owner decision",
  scheduling: "buyer to pick a pickup slot",
  handoff: "both parties to confirm the hand-off",
  done: "nothing",
};

function dealStep(stage: Exclude<DealStage, "done">, deps: WorkflowDeps) {
  return createStep({
    id: stage,
    inputSchema: StageIO,
    outputSchema: StageIO,
    suspendSchema: z.object({ awaiting: z.string(), since: z.string() }),
    resumeSchema: Event,
    execute: async ({ inputData, resumeData, suspend }) => {
      // The deal may already be past this stage (an earlier event moved it two stages at once).
      if (stageIndex(inputData.stage) > stageIndex(stage)) return inputData;
      if (!resumeData) {
        return await suspend({ awaiting: awaitingFor[stage], since: new Date().toISOString() });
      }
      const deal = await deps.dispatch(inputData.dealId, resumeData as DealEvent);
      const out: StageIO = { dealId: deal.id, status: deal.status, stage: deal.stage };
      if (stageIndex(deal.stage) > stageIndex(stage)) return out;
      return await suspend({ awaiting: awaitingFor[stage], since: new Date().toISOString() });
    },
  });
}

export function createDealWorkflow(deps: WorkflowDeps) {
  return createWorkflow({ id: "deal", inputSchema: StageIO, outputSchema: StageIO })
    .then(dealStep("negotiating", deps))
    .then(dealStep("scheduling", deps))
    .then(dealStep("handoff", deps))
    .commit();
}

const LastCallIO = z.object({ moveId: z.string() });
const Timer = z.object({ now: z.string() });

function lastCallStep(stage: "drop" | "free" | "close", deps: WorkflowDeps) {
  return createStep({
    id: stage,
    inputSchema: LastCallIO,
    outputSchema: LastCallIO,
    suspendSchema: z.object({ stage: z.string(), awaiting: z.string() }),
    resumeSchema: Timer,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return await suspend({ stage, awaiting: "timer" });
      await deps.fireLastCall(inputData.moveId, stage);
      return inputData;
    },
  });
}

export function createLastCallWorkflow(deps: WorkflowDeps) {
  return createWorkflow({ id: "last_call", inputSchema: LastCallIO, outputSchema: LastCallIO })
    .then(lastCallStep("drop", deps))
    .then(lastCallStep("free", deps))
    .then(lastCallStep("close", deps))
    .commit();
}

export function createEngineMastra(storage: MastraStorage, deps: WorkflowDeps) {
  return new Mastra({
    storage,
    workflows: { deal: createDealWorkflow(deps), last_call: createLastCallWorkflow(deps) },
    logger: false,
  });
}
