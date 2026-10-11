// Display names for personas and purposes (the policy's own labels; policy/policy.yaml).
import type { Persona, Purpose } from "./api.ts";

export const PERSONA_LABELS: Record<Persona, string> = {
  hr_partner: "HR Business Partner",
  manager: "People Manager",
  people_analyst: "People Analyst",
  privacy_officer: "Privacy Officer",
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
  employee_relations: "Employee relations",
  team_management: "Team management",
  workforce_analytics: "Workforce analytics",
  privacy_compliance: "Privacy compliance",
  legal_hold_management: "Legal hold management",
};
