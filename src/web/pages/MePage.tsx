// Home: who the caller is (opaque principal id and persona) and what each of their purposes allows.
import type { Me, Purpose } from "../api.ts";
import { PERSONA_LABELS, PURPOSE_LABELS } from "../labels.ts";
import { DATA_PURPOSES, hrefFor, type DataPurpose } from "../router.ts";
import { Link } from "../ui.tsx";

const WHAT: Record<Purpose, string> = {
  employee_relations: "Profiles of employees in your org units, with leave details masked.",
  team_management: "Your direct reports, with compensation masked.",
  workforce_analytics: "Pseudonymous analytics rows (analytics_id only, birth dates reduced to the year).",
  privacy_compliance: "Identity lookup, deletion requests, the coverage report and the audit log.",
  legal_hold_management: "Identity lookup and legal holds that pause deletion.",
};

function start(p: Purpose): string {
  if ((DATA_PURPOSES as readonly string[]).includes(p)) return hrefFor({ page: "employees", purpose: p as DataPurpose });
  return p === "legal_hold_management" ? hrefFor({ page: "holds" }) : hrefFor({ page: "requests" });
}

export function MePage(props: { me: Me }) {
  return (
    <section>
      <h1>{PERSONA_LABELS[props.me.persona]}</h1>
      <p className="muted">
        Principal <code>{props.me.principalId}</code>. Each purpose shows only the rows and columns the policy grants it.
      </p>
      <ul className="cards">
        {props.me.purposes.map((p) => (
          <li key={p}>
            <Link to={start(p)}>{PURPOSE_LABELS[p]}</Link>
            <p>{WHAT[p]}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
