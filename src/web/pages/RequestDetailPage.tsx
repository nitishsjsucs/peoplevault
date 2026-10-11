// One deletion request: status, the per-asset results (applicability, erasure, independent verification), residuals
// tracked separately from coverage (Iceberg snapshots, BigQuery time travel and fail-safe, D1 Time Travel), the
// receipt with its audit hash, and a retry for a failed request.
import { useState } from "react";
import { getReceipt, getRequest, retryRequest, type Started } from "../api.ts";
import { hrefFor } from "../router.ts";
import { ErrorNote, Link, Loading, Status, useAsync } from "../ui.tsx";

const num = (n: number | null) => (n === null ? "" : String(n));

export function RequestDetailPage(props: { id: string }) {
  const [res, reload] = useAsync(() => getRequest(props.id), props.id);
  const [receipt, setReceipt] = useState<Awaited<ReturnType<typeof getReceipt>> | null>(null);
  const [retried, setRetried] = useState<Started | null>(null);
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section>
      <p>
        <Link to={hrefFor({ page: "requests" })}>Back to requests</Link>
      </p>
      <h1>Deletion request</h1>
      {res.state === "loading" ? <Loading /> : null}
      {res.state === "error" ? <ErrorNote error={res.error} /> : null}
      {res.state === "ready" ? (
        <>
          <dl className="fields">
            <div>
              <dt>Request</dt>
              <dd>
                <code>{res.data.request.id}</code>
              </dd>
            </div>
            <div>
              <dt>Subject</dt>
              <dd>
                <code>{res.data.request.subjectRef}</code>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <Status status={res.data.request.status} />
              </dd>
            </div>
            <div>
              <dt>Workflow instance</dt>
              <dd>
                <code>{res.data.request.workflowInstanceId ?? "not started (waiting for the daily admission)"}</code>
              </dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd>{res.data.request.createdAt}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>{res.data.request.completedAt ?? ""}</dd>
            </div>
          </dl>
          <div className="actions">
            <button type="button" onClick={reload}>
              Refresh
            </button>
            {res.data.request.summary ? (
              <button type="button" onClick={() => void act(async () => setReceipt(await getReceipt(props.id)))}>
                Show receipt
              </button>
            ) : null}
            {res.data.request.status === "failed" ? (
              <button
                type="button"
                onClick={() =>
                  void act(async () => {
                    setRetried(await retryRequest(props.id));
                    reload();
                  })
                }
              >
                Retry
              </button>
            ) : null}
          </div>
          {error ? <ErrorNote error={error} /> : null}
          {retried ? (
            <p className="note ok" role="status">
              {retried.deferred ? "Retry accepted; the daily reconcile starts it tomorrow." : `Retry started as ${retried.instanceId ?? "a new instance"}.`}
            </p>
          ) : null}
          {receipt ? (
            <div className="receipt">
              <h2>Receipt</h2>
              <p className="muted">{receipt.audit ? `Audit event ${receipt.audit.seq}, hash ${receipt.audit.hash}` : "No receipt event in the audit log."}</p>
              <pre>{JSON.stringify(receipt.receipt, null, 2)}</pre>
            </div>
          ) : null}
          <h2>Assets</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col">Category</th>
                  <th scope="col">Applicability</th>
                  <th scope="col">Rows before</th>
                  <th scope="col">Erased</th>
                  <th scope="col">Refs scrubbed</th>
                  <th scope="col">Action</th>
                  <th scope="col">Verification</th>
                  <th scope="col">Matches</th>
                </tr>
              </thead>
              <tbody>
                {res.data.assets.map((a) => (
                  <tr key={a.asset_id}>
                    <td>
                      <code>{a.asset_id}</code>
                    </td>
                    <td>{a.category}</td>
                    <td>{a.applicability.replace(/_/g, " ")}</td>
                    <td>{num(a.rows_before)}</td>
                    <td>{num(a.rows_erased)}</td>
                    <td>{num(a.references_scrubbed)}</td>
                    <td>{a.action_status.replace(/_/g, " ")}</td>
                    <td>
                      <Status status={a.verify_status} />
                    </td>
                    <td>{num(a.verify_matches)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Residuals</h2>
          {res.data.residuals.length === 0 ? (
            <p className="note muted">None recorded.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Asset</th>
                    <th scope="col">State</th>
                    <th scope="col">Evidence</th>
                    <th scope="col">Expected to clear</th>
                    <th scope="col">Cleared</th>
                  </tr>
                </thead>
                <tbody>
                  {res.data.residuals.map((r) => (
                    <tr key={r.id}>
                      <td>{r.kind.replace(/_/g, " ")}</td>
                      <td>
                        <code>{r.asset_id}</code>
                      </td>
                      <td>
                        <Status status={r.state} />
                      </td>
                      <td>{r.evidence}</td>
                      <td>{r.expected_clear_at ?? ""}</td>
                      <td>{r.cleared_at ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
