import compiledJson from "../../../policy/compiled/policy.json";
import { CATEGORIES, PERSONAS, PURPOSES, type CompiledPolicy, type Purpose, type QueryDef } from "../../shared/policy-types.ts";

function validate(p: CompiledPolicy): CompiledPolicy {
  const problems: string[] = [];
  if (p.version !== 1) problems.push("version");
  if (Object.keys(p.personas).join() !== PERSONAS.join()) problems.push("personas");
  if (Object.keys(p.purposes).join() !== PURPOSES.join()) problems.push("purposes");
  if (p.categories.join() !== CATEGORIES.join()) problems.push("categories");
  if (problems.length > 0) throw new Error(`compiled policy is inconsistent: ${problems.join(", ")}`);
  return p;
}

/** Typed, validated view over policy/compiled/policy.json. */
export const POLICY: CompiledPolicy = validate(compiledJson as unknown as CompiledPolicy);

export function queryDef(id: string): QueryDef | undefined {
  return POLICY.queries[id];
}

export function queryFor(purpose: Purpose, name: string): QueryDef | undefined {
  return POLICY.queries[`${purpose}.${name}`];
}
