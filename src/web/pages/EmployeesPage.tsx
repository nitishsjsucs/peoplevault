// Purpose-scoped employee browser: one page of rows (at most 100) from GET /api/v1/purposes/:purpose/employees.
// The Worker returns only the columns the purpose may see and the rows of the caller's scope; masked columns are
// labeled in the header. Rows link to profiles by pseudonymous ref (employee_ref or analytics_id), never by name.
import { useState } from "react";
import { getEmployees, type Visibility } from "../api.ts";
import { hrefFor, type DataPurpose } from "../router.ts";
import { ColumnName, ErrorNote, formatCell, Link, Loading, useAsync } from "../ui.tsx";

const REF_COLUMNS = ["employee_ref", "analytics_id"] as const;

export function EmployeesPage(props: { purpose: DataPurpose }) {
  // cursors of the pages before the current one; the last element is the current page's cursor
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const [page] = useAsync(() => getEmployees(props.purpose, cursor), `${props.purpose}|${cursor ?? ""}`);
  return (
    <section>
      <h1>Employees</h1>
      {page.state === "loading" ? <Loading /> : null}
      {page.state === "error" ? <ErrorNote error={page.error} /> : null}
      {page.state === "ready" ? (
        <>
          <EmployeeTable purpose={props.purpose} rows={page.data.rows} columns={page.data.columns} />
          <div className="pager">
            <span className="muted">
              Page {cursors.length}, {page.data.rows.length} rows
            </span>
            <button type="button" disabled={cursors.length < 2} onClick={() => setCursors((c) => c.slice(0, -1))}>
              Previous
            </button>
            <button type="button" disabled={!page.data.nextCursor} onClick={() => setCursors((c) => [...c, page.data.nextCursor])}>
              Next
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function EmployeeTable(props: { purpose: DataPurpose; rows: Record<string, unknown>[]; columns: Record<string, Visibility> }) {
  const cols = Object.entries(props.columns).filter(([, v]) => v !== "deny");
  const refCol = REF_COLUMNS.find((c) => c in props.columns && props.columns[c] === "allow");
  if (props.rows.length === 0) return <p className="note muted">No rows in your scope.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map(([name, vis]) => (
              <th key={name} scope="col">
                <ColumnName name={name} visibility={vis} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, i) => {
            const ref = refCol ? String(row[refCol] ?? "") : "";
            return (
              <tr key={ref || i}>
                {cols.map(([name, vis]) => (
                  <td key={name}>{name === refCol && ref ? <Link to={hrefFor({ page: "profile", purpose: props.purpose, ref })}>{ref}</Link> : formatCell(row[name], vis)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
