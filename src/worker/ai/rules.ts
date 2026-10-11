// Rule classes for a quarantined column (SPEC.md section 16.3): keyword rules over the column name and pattern rules
// over the sample values. The rule class is the floor of a triage suggestion: the suggestion is
// max_severity(rule_class, model_class), so a model can raise a column's sensitivity but never lower it below what
// the rules see. A suggestion never changes policy; only a human edit of policy.yaml releases a quarantined export.
import type { DataClass } from "../../shared/policy-types.ts";
import { POLICY } from "../policy/compiled.ts";

export const DATA_CLASSES: readonly DataClass[] = [...POLICY.dataClasses.tagged, ...POLICY.dataClasses.untagged];

/** Higher is more sensitive. Tagged classes rank above every untagged one. */
export const SEVERITY: Readonly<Record<DataClass, number>> = {
  direct_identifier: 9,
  health_leave: 8,
  protected_attribute: 7,
  date_of_birth: 6,
  compensation: 5,
  performance: 4,
  pseudonym: 3,
  job: 2,
  coarsened: 1,
};

export const isSensitive = (c: DataClass): boolean => (POLICY.dataClasses.tagged as readonly string[]).includes(c);

export function isDataClass(v: unknown): v is DataClass {
  return typeof v === "string" && (DATA_CLASSES as readonly string[]).includes(v);
}

export function maxSeverity(...classes: (DataClass | null)[]): DataClass | null {
  let best: DataClass | null = null;
  for (const c of classes) if (c && (!best || SEVERITY[c] > SEVERITY[best])) best = c;
  return best;
}

// Name rules, most sensitive first; the first match wins. Names are compared lower-case with separators as "_".
const NAME_RULES: [RegExp, DataClass][] = [
  [/e_?mail|phone|mobile|cell|fax|address|street|city_of_residence|zip|postcode|postal|full_?name|first_?name|last_?name|surname|given_?name|family_?name|maiden|nick_?name|employee_?id|emp_?id|employee_?number|badge|ssn|social_security|national_?id|passport|tax_?id|driver|licen[cs]e_?no|iban|bank|account_?(no|number)|card_?number|personal_?id|login|username|user_?name|ip_?addr|device_?id|emergency_?contact|next_?of_?kin|home_/, "direct_identifier"],
  [/sick|medical|health|diagnos|disab|accommodat|pregnan|maternity|paternity|fmla|injur|illness|therap|prescri|clinic|doctor|condition|wellness_?claim|leave_?(reason|type|note)/, "health_leave"],
  [/gender|(^|_)sex(_|$)|ethnic|race|religio|faith|nationality|citizenship|sexual|orientation|marital|veteran|union_?member|political|pronoun|(^|_)age(_|$)|caste/, "protected_attribute"],
  [/birth|(^|_)dob(_|$)|born/, "date_of_birth"],
  [/salary|wage|(^|_)pay(_|$)|payroll|bonus|compensation|(^|_)comp(_|$)|stock|equity|(^|_)rsu|commission|allowance|pension|401k|gross|net_?pay|hourly_?rate|(^|_)ote(_|$)|merit_?increase|raise_?pct/, "compensation"],
  [/rating|review|performance|(^|_)perf(_|$)|appraisal|feedback|calibration|(^|_)pip(_|$)|warning|disciplin|potential|nine_?box|goal_?score/, "performance"],
  [/(^|_)(band|bucket|range|bin|bracket|decile|quartile)(_|$)|_band$|_bucket$|_range$/, "coarsened"],
  [/(_|^)(ref|key|hash|pseudonym|token|surrogate)(_|$)/, "pseudonym"],
  [/title|level|grade|department|(^|_)dept|org_?unit|team|location|site|office|status|cost_?cent|division|function|hire|start_?date|end_?date|tenure|manager_?flag|fte|shift|contract_?type/, "job"],
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
// international numbers with a leading +, or 3-3-4 digit groups; never an ISO date
const PHONE = /^(\+\d[\d\s().-]{6,}\d|\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})$/;
const GOV_ID = /^\d{3}-\d{2}-\d{4}$/;
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

function nameRule(column: string): DataClass | null {
  const n = column.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  for (const [rx, cls] of NAME_RULES) if (rx.test(n)) return cls;
  return null;
}

/** A value rule fires when at least half of the non-empty samples (and at least 2) match one pattern. Person names
 * are left to the model: a name pattern would also match job titles and org unit names. */
function valueRule(samples: string[]): DataClass | null {
  const vals = samples.map((s) => s.trim()).filter(Boolean);
  if (vals.length === 0) return null;
  const need = Math.max(2, Math.ceil(vals.length / 2));
  const count = (rx: RegExp) => vals.filter((v) => rx.test(v)).length;
  if (count(EMAIL) >= need || count(PHONE) >= need || count(GOV_ID) >= need || count(IBAN) >= need) return "direct_identifier";
  return null;
}

export function ruleClass(column: string, samples: string[]): DataClass | null {
  return maxSeverity(nameRule(column), valueRule(samples));
}
