// Legal holds (legal_hold_management): place a hold on a person found by identity lookup, list holds, release one.
// A held subject's deletion pauses; releasing the last hold resubmits held requests (deferred past the daily cap).
import { useState } from "react";
import { listHolds, placeHold, releaseHold, type Hold } from "../api.ts";
import { IdentityLookup, ReasonAction } from "../lookup.tsx";
import { ErrorNote, FormError, Loading, shortRef, useAsync } from "../ui.tsx";

const MATTER = /^[A-Z]{2}-\d{4}-\d{3}$/;

export function HoldsPage() {
  const [list, reload] = useAsync(listHolds, "holds");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const release = async (h: Hold) => {
    setError(null);
    try {
      const r = await releaseHold(h.id);
      setMessage(
        `Released ${r.hold.matterId}. ${r.remainingHolds} other active hold(s) on this subject; ${r.resubmitted.length} held request(s) resubmitted, ${r.deferred.length} deferred to the daily reconcile.`,
      );
      reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section>
      <h1>Legal holds</h1>
      <h2>Place a hold</h2>
      <IdentityLookup
        purpose="legal_hold_management"
        action={(row, done) => (
          <ReasonAction
            label="Place hold"
            extra={(value, set) => (
              <label>
                Matter id (for example LH-2026-001)
                <input value={value} onChange={(e) => set(e.target.value.toUpperCase())} pattern="[A-Z]{2}-[0-9]{4}-[0-9]{3}" required />
              </label>
            )}
            onConfirm={async (reason, matter) => {
              if (!MATTER.test(matter)) throw new FormError("The matter id must look like LH-2026-001.");
              const r = await placeHold(matter, row.employee_ref, reason);
              setMessage(`Hold ${r.hold.matterId} placed.`);
              done();
              reload();
            }}
          />
        )}
      />
      {message ? (
        <p className="note ok" role="status">
          {message}
        </p>
      ) : null}
      {error ? <ErrorNote error={error} /> : null}
      <h2>Holds</h2>
      {list.state === "loading" ? <Loading /> : null}
      {list.state === "error" ? <ErrorNote error={list.error} /> : null}
      {list.state === "ready" && list.data.holds.length === 0 ? <p className="note muted">No holds.</p> : null}
      {list.state === "ready" && list.data.holds.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Matter</th>
                <th scope="col">Subject</th>
                <th scope="col">Placed</th>
                <th scope="col">Released</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {list.data.holds.map((h) => (
                <tr key={h.id}>
                  <td>{h.matterId}</td>
                  <td>
                    <code title={h.subjectRef}>{shortRef(h.subjectRef)}</code>
                  </td>
                  <td>{h.placedAt}</td>
                  <td>{h.releasedAt ?? ""}</td>
                  <td>
                    {h.releasedAt ? null : (
                      <button type="button" onClick={() => void release(h)}>
                        Release
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
