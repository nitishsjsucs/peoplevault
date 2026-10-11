// One profile under one purpose (GET /api/v1/purposes/:purpose/employees/:ref). An unknown, suppressed or
// out-of-scope ref is a 404 from the Worker, so the console cannot tell them apart either (no existence oracle).
import { getProfile } from "../api.ts";
import { hrefFor, type DataPurpose } from "../router.ts";
import { ColumnName, ErrorNote, formatCell, Link, Loading, useAsync } from "../ui.tsx";

export function ProfilePage(props: { purpose: DataPurpose; refId: string }) {
  const [res] = useAsync(() => getProfile(props.purpose, props.refId), `${props.purpose}|${props.refId}`);
  return (
    <section>
      <p>
        <Link to={hrefFor({ page: "employees", purpose: props.purpose })}>Back to employees</Link>
      </p>
      <h1>Profile</h1>
      {res.state === "loading" ? <Loading /> : null}
      {res.state === "error" ? <ErrorNote error={res.error} /> : null}
      {res.state === "ready" ? (
        <dl className="fields">
          {Object.entries(res.data.columns)
            .filter(([, vis]) => vis !== "deny")
            .filter(([name]) => name in res.data.profile)
            .map(([name, vis]) => (
              <div key={name}>
                <dt>
                  <ColumnName name={name} visibility={vis} />
                </dt>
                <dd>{formatCell(res.data.profile[name], vis)}</dd>
              </div>
            ))}
        </dl>
      ) : null}
    </section>
  );
}
