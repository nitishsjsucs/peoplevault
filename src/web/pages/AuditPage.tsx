// The audit log: events 200 at a time (opaque principal ids and subject_ref only, never an identifier), and a chain
// check that walks the hash chain one 100-event window per request (Workers Free, SPEC.md section 30.3.2).
import { useState } from "react";
import { getAudit, verifyChain, type AuditEvent, type ChainResult } from "../api.ts";
import { ErrorNote, Loading, shortRef, useAsync } from "../ui.tsx";

export function AuditPage() {
  const [first] = useAsync(() => getAudit(null), "audit");
  const [more, setMore] = useState<{ events: AuditEvent[]; cursor: number | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [progress, setProgress] = useState<{ checked: number; windows: number } | null>(null);
  const [chain, setChain] = useState<ChainResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  const cursor = more ? more.cursor : first.state === "ready" ? first.data.cursor : null;
  const loadMore = async () => {
    try {
      const next = await getAudit(cursor);
      setMore({ events: [...(more?.events ?? []), ...next.events], cursor: next.cursor });
    } catch (e) {
      setError(e);
    }
  };
  const verify = async () => {
    setVerifying(true);
    setChain(null);
    setError(null);
    try {
      setChain(await verifyChain((checked, windows) => setProgress({ checked, windows })));
    } catch (e) {
      setError(e);
    } finally {
      setVerifying(false);
    }
  };
  const events = first.state === "ready" ? [...first.data.events, ...(more?.events ?? [])] : [];
  return (
    <section>
      <h1>Audit log</h1>
      <div className="actions">
        <button type="button" onClick={() => void verify()} disabled={verifying}>
          Verify the hash chain
        </button>
        {verifying && progress ? (
          <span className="muted">
            {progress.checked} events checked in {progress.windows} windows
          </span>
        ) : null}
      </div>
      {chain ? <ChainNote result={chain} /> : null}
      {error ? <ErrorNote error={error} /> : null}
      {first.state === "loading" ? <Loading /> : null}
      {first.state === "error" ? <ErrorNote error={first.error} /> : null}
      {first.state === "ready" ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Seq</th>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Purpose</th>
                <th scope="col">Action</th>
                <th scope="col">Route</th>
                <th scope="col">Subject</th>
                <th scope="col">Decision</th>
                <th scope="col">Reason</th>
                <th scope="col">Rows</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td>{e.ts}</td>
                  <td>
                    <code>{e.actor}</code>
                  </td>
                  <td>{e.purpose ?? ""}</td>
                  <td>{e.action}</td>
                  <td>
                    <code>{e.route ?? ""}</code>
                  </td>
                  <td>
                    <code title={e.subject_ref ?? ""}>{shortRef(e.subject_ref)}</code>
                  </td>
                  <td className={`decision-${e.decision}`}>{e.decision}</td>
                  <td>{e.reason}</td>
                  <td>{e.row_count ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {cursor !== null ? (
        <button type="button" onClick={() => void loadMore()}>
          Next events
        </button>
      ) : null}
    </section>
  );
}

function ChainNote(props: { result: ChainResult }) {
  const r = props.result;
  if (r.ok)
    return (
      <p className="note ok" role="status">
        Chain intact: {r.checked} events in {r.windows} windows, last hash <code>{r.lastHash}</code>.
      </p>
    );
  const why = r.reason === "anchor_mismatch" ? "a window did not start on the previous window's last hash" : r.reason === "no_progress" ? "the server stopped advancing" : "an event's hash does not chain";
  return (
    <p className="note error" role="alert">
      Chain broken at seq {r.brokenAtSeq ?? "?"}: {why} ({r.checked} events checked).
    </p>
  );
}
