// Identity lookup for the privacy officer (POST /api/v1/purposes/:purpose/identity-lookup, never cached). The search
// text stays in component state and goes out only as a POST body: the input has no name and the form posts, so even
// a submit without JavaScript could not put a name or email prefix into a URL (SPEC.md section 11.5).
import { useState, type FormEvent, type ReactNode } from "react";
import { identityLookup, type LookupRow } from "./api.ts";
import { ErrorNote } from "./ui.tsx";

export function IdentityLookup(props: { purpose: "privacy_compliance" | "legal_hold_management"; action: (row: LookupRow, done: () => void) => ReactNode }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<LookupRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setRows((await identityLookup(props.purpose, q.trim())).rows);
    } catch (err) {
      setError(err);
      setRows(null);
    } finally {
      setBusy(false);
    }
  };
  // clears the search and its results once the officer has acted on a row: names leave the screen
  const done = () => {
    setQ("");
    setRows(null);
  };
  return (
    <div className="lookup">
      <form method="post" onSubmit={(e) => void submit(e)} className="inline" autoComplete="off">
        <label>
          Find a person (name or work email prefix, at least 3 characters)
          <input value={q} onChange={(e) => setQ(e.target.value)} minLength={3} maxLength={100} required />
        </label>
        <button type="submit" disabled={busy || q.trim().length < 3}>
          Look up
        </button>
      </form>
      {error ? <ErrorNote error={error} /> : null}
      {rows && rows.length === 0 ? <p className="note muted">No match.</p> : null}
      {rows && rows.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">employee_ref</th>
                <th scope="col">full_name</th>
                <th scope="col">work_email</th>
                <th scope="col">org_unit</th>
                <th scope="col">employment_status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employee_ref}>
                  <td>
                    <code>{r.employee_ref}</code>
                  </td>
                  <td>{r.full_name}</td>
                  <td>{r.work_email}</td>
                  <td>{r.org_unit}</td>
                  <td>{r.employment_status}</td>
                  <td>{props.action(r, done)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** A reason field and a confirm button for one row, shown after the officer picks it. */
export function ReasonAction(props: { label: string; extra?: (value: string, set: (v: string) => void) => ReactNode; onConfirm: (reason: string, extra: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)}>
        {props.label}
      </button>
    );
  const confirm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(reason.trim(), extra.trim());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form method="post" onSubmit={(e) => void confirm(e)} className="stack" autoComplete="off">
      {props.extra?.(extra, setExtra)}
      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={200} required />
      </label>
      <button type="submit" disabled={busy || reason.trim().length < 3}>
        Confirm {props.label.toLowerCase()}
      </button>
      {error ? <ErrorNote error={error} /> : null}
    </form>
  );
}
