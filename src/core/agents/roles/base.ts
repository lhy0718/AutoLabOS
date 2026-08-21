import { AgentRoleId } from "../../../types.js";
import { LLMClient } from "../../llm/client.js";

export interface RoleExecutionInput {
  goal: string;
  context: string;
  constraints: string[];
}

export interface RoleExecutionResult {
  output: string;
  sop: string[];
}

export interface RoleAgent {
  readonly id: AgentRoleId;
  readonly sop: string[];
  execute(input: RoleExecutionInput): Promise<RoleExecutionResult>;
}

export class BasicRoleAgent implements RoleAgent {
  constructor(
    readonly id: AgentRoleId,
    readonly sop: string[],
    private readonly llm: LLMClient
  ) {}

  async execute(input: RoleExecutionInput): Promise<RoleExecutionResult> {
    const prompt = [
      `Role: ${this.id}`,
      `Goal: ${input.goal}`,
      `Context: ${input.context}`,
      `Constraints: ${input.constraints.join(", ") || "none"}`,
      "Follow SOP:",
      ...this.sop.map((step, idx) => `${idx + 1}. ${step}`)
    ].join("\n");

    const completion = await this.llm.complete(prompt);
    return {
      output: completion.text,
      sop: this.sop
    };
  }
}
