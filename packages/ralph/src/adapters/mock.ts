import type { AgentRequest, AgentResult, AgentUsage, RunnerAdapter } from "./types";

/**
 * In-memory adapter for unit tests and the loop e2e. It never spawns a process;
 * instead a handler decides each turn's result, allowing tests to simulate
 * agent output and (via `scripted`) real file mutations in the working tree.
 */

export type MockHandler = (
  req: AgentRequest,
  callIndex: number,
) => AgentResult | Promise<AgentResult>;

export interface MockTurn {
  /** Simulate the agent editing files under `cwd` before returning output. */
  mutate?: (cwd: string) => void | Promise<void>;
  output: string;
  usage?: AgentUsage;
  exitCode?: number;
}

export class MockAdapter implements RunnerAdapter {
  readonly name = "mock";

  private callIndex = 0;
  private readonly handler: MockHandler;

  constructor(handler: MockHandler) {
    this.handler = handler;
  }

  /**
   * Build a MockAdapter that plays a fixed sequence of turns. Each invoke runs
   * the next turn (awaiting its `mutate` to simulate file edits). Once the
   * sequence is exhausted it repeats the final turn's output with no mutate.
   */
  static scripted(turns: MockTurn[]): MockAdapter {
    return new MockAdapter(async (req, callIndex) => {
      const exhausted = callIndex >= turns.length;
      const turn = exhausted ? turns[turns.length - 1] : turns[callIndex];
      if (!turn) {
        return { exitCode: 0, rawOutput: "", durationMs: 1, timedOut: false };
      }
      if (!exhausted && turn.mutate) {
        await turn.mutate(req.cwd);
      }
      return {
        exitCode: turn.exitCode ?? 0,
        rawOutput: turn.output,
        usage: turn.usage,
        durationMs: 1,
        timedOut: false,
      };
    });
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async invoke(req: AgentRequest): Promise<AgentResult> {
    const idx = this.callIndex++;
    return this.handler(req, idx);
  }
}
