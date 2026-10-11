// The triage prompt (SPEC.md section 30.3.6): a fixed instruction, the column name and at most 5 sample values of at
// most 60 characters each. The whole prompt is refused above 2,400 characters (about 600 input tokens), and the
// answer is constrained to `{ "class": <one of the 9 data classes> }` by a JSON schema.
import { DATA_CLASSES } from "./rules.ts";
import { MAX_PROMPT_CHARS } from "./rates.ts";

export const MAX_SAMPLES = 5;
export const MAX_SAMPLE_CHARS = 60;

export interface Message {
  role: "system" | "user";
  content: string;
}

export class PromptTooLong extends Error {
  override name = "PromptTooLong";
}

export const SYSTEM_PROMPT = [
  "You classify one column of an HR data export for a privacy policy.",
  'Reply with JSON {"class": "<class>"} and nothing else. Classes:',
  "direct_identifier: identifies a person (names, emails, phone numbers, addresses, employee or government ids, account numbers).",
  "date_of_birth: birth dates.",
  "compensation: pay, salary, bonus, equity or benefit amounts.",
  "performance: ratings, reviews, feedback, goals, disciplinary notes.",
  "health_leave: medical, sickness, disability, accommodations, reasons for leave.",
  "protected_attribute: gender, race or ethnicity, religion, sexual orientation, nationality, marital or veteran status, union membership, age.",
  "job: title, level, department, location, employment dates and status, other work facts.",
  "coarsened: bands, buckets or ranges that group people.",
  "pseudonym: opaque keys or tokens that stand in for a person.",
  "When unsure between two classes, choose the more sensitive one.",
].join("\n");

/** JSON schema of the answer, shared by Workers AI (`response_format`) and llama-server (grammar). */
export const ANSWER_SCHEMA = {
  type: "object",
  properties: { class: { type: "string", enum: [...DATA_CLASSES] } },
  required: ["class"],
  additionalProperties: false,
} as const;

export function clipSamples(samples: string[]): string[] {
  return samples
    .slice(0, MAX_SAMPLES)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .map((s) => (s.length > MAX_SAMPLE_CHARS ? s.slice(0, MAX_SAMPLE_CHARS) : s));
}

export function buildMessages(column: string, samples: string[], suffix = ""): Message[] {
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT + suffix },
    { role: "user", content: `Column: ${column}\nSample values (synthetic): ${JSON.stringify(clipSamples(samples))}` },
  ];
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  if (chars > MAX_PROMPT_CHARS) throw new PromptTooLong(`prompt of ${chars} characters exceeds ${MAX_PROMPT_CHARS}`);
  return messages;
}

export const promptChars = (messages: Message[]) => messages.reduce((n, m) => n + m.content.length, 0);
