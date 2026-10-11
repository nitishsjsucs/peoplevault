// Deletion requests (privacy_compliance): find the person, file a request by employee_ref, and follow every request.
// On Workers Free at most DAILY_DELETION_STARTS deletions start per UTC day; a request over the cap is accepted and
// started by the next daily reconcile (SPEC.md section 30.3.4), which the console says instead of failing.
import { useState } from "react";
import { createRequest, listRequests, type RequestStatus, type Started } from "../api.ts";
import { IdentityLookup, ReasonAction } from "../lookup.tsx";
import { hrefFor } from "../router.ts";
import { ErrorNote, Link, Loading, shortRef, Status, useAsync } from "../ui.tsx";

const STATUSES: RequestStatus[] = ["received", "held", "running", "completed", "completed_with_residuals", "failed"];

export function RequestsPage() {
  const [status, setStatus] = useState<RequestStatus | "">("");
  const [created, setCreated] = useState<Started | null>(null);
  const [list, reload] = useAsync(() => listRequests(status || null), status);
  return (
    <section>
      <h1>Deletion requests</h1>
      <h2>New request</h2>
      <IdentityLookup
        purpose="privacy_compliance"
        action={(row, done) => (
          <ReasonAction
            label="Request deletion"
            onConfirm={async (reason) => {
              setCreated(await createRequest(row.employee_ref, reason));
              done();
              reload();
            }}
          />
        )}
      />
      {created ? (
        <p className="note ok" role="status">
          Request <Link to={hrefFor({ page: "request", id: created.requestId })}>{created.requestId}</Link> received.
          {created.deferred ? " Today's deletion starts are used up; the daily reconcile starts it tomorrow." : " The deletion workflow has started."}
        </p>
      ) : null}
      <h2>All requests</h2>
      <label className="inline">
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value as RequestStatus | "")}>
          <option value="">any</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="link" onClick={reload}>
        Refresh
      </button>
      {list.state === "loading" ? <Loading /> : null}
      {list.state === "error" ? <ErrorNote error={list.error} /> : null}
      {list.state === "ready" && list.data.requests.length === 0 ? <p className="note muted">No requests.</p> : null}
      {list.state === "ready" && list.data.requests.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Kind</th>
                <th scope="col">Subject</th>
                <th scope="col">Status</th>
                <th scope="col">Received</th>
                <th scope="col">Admitted</th>
                <th scope="col">Finished</th>
              </tr>
            </thead>
            <tbody>
              {[...list.data.requests].reverse().map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={hrefFor({ page: "request", id: r.id })}>{shortRef(r.id)}</Link>
                  </td>
                  <td>{r.kind}</td>
                  <td>
                    <code title={r.subjectRef}>{shortRef(r.subjectRef)}</code>
                  </td>
                  <td>
                    <Status status={r.status} />
                  </td>
                  <td>{r.createdAt}</td>
                  <td>{r.admittedAt ?? ""}</td>
                  <td>{r.completedAt ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
