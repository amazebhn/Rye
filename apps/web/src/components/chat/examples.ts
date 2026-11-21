import type { PromptGroup } from "../../utils/types";

export const PROMPT_GROUPS: PromptGroup[] = [
  {
    id: "triage",
    label: "Incident triage",
    prompts: [
      { title: "Triage a 5xx spike", prompt: "We're seeing elevated 5xx on service-api since ~10:20 UTC. Help me triage step-by-step and tell me exactly what evidence to gather first." },
      { title: "Rank latency hypotheses", prompt: "Given this symptom: latency p95 doubled, error rate stable — list top 5 hypotheses and the fastest test for each." },
      { title: "Incident commander mode", prompt: "Act as incident commander. Ask me only the most critical questions first, one at a time." },
    ],
  },
  {
    id: "logs",
    label: "Logs & traces",
    prompts: [
      { title: "Root-cause a stack trace", prompt: "Analyze this stack trace and identify probable root cause, blast radius, and first rollback/mitigation option." },
      { title: "Find the log anomaly", prompt: "Here are log lines around the failure window. Find the key anomaly and suggest the next 3 log queries." },
      { title: "Locate the failing code", prompt: "Convert this noisy error into a likely source file + function I should inspect first." },
    ],
  },
  {
    id: "infra",
    label: "Database & infra",
    prompts: [
      { title: "Tune a slow query", prompt: "Given this slow query plan, suggest 3 index strategies and the tradeoffs." },
      { title: "Check pool exhaustion", prompt: "I suspect connection pool exhaustion. What metrics and logs would confirm or refute that?" },
      { title: "Explain an ECS CPU spike", prompt: "Help me investigate a sudden ECS CPU spike with no deploy: what CloudWatch metrics and dimensions should I correlate?" },
    ],
  },
  {
    id: "runbooks",
    label: "Runbooks & SOPs",
    prompts: [
      { title: "Incident summary to SOP", prompt: "Turn this incident summary into a reusable SOP with: triggers, diagnostics, decision points, mitigation, and rollback." },
      { title: "Draft an on-call runbook", prompt: "Create a short runbook for on-call with a 10-minute quick path and a deep-dive path." },
      { title: "Debug config overrides", prompt: "I changed config but behavior didn't change. Give me a checklist to detect env var overrides vs config file values." },
    ],
  },
];