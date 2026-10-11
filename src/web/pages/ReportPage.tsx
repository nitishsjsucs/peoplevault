// Coverage report (GET /api/v1/privacy/reports/deletion, SPEC.md section 14.7): coverage of applicable active-data
// asset pairs with its denominator, per category ("n/a" when a category had no applicable pair, never 100%), held
// requests and aggregate recomputes as separate buckets, residuals by kind and state, and failures paged 100 at a time.
import { useState, type FormEvent } from "react";
import { getReport, type Report } from "../api.ts";
import { hrefFor } from "../router.ts";
import { ErrorNote, Link, Loading, shortRef, useAsync } from "../ui.tsx";

/** The report compares ISO timestamps; a picked day covers the whole UTC day. */
export function windowOf(range: { from: string; to: string }): [string | null, string | null] {
  return [range.from ? `${range.from}T00:00:00.000Z` : null, range.to ? `${range.to}T23:59:59.999Z` : null];
}

export function ReportPage() {
  const [range, setRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [draft, setDraft] = useState(range);
  const [res] = useAsync(() => getReport(...windowOf(range), null), `${range.from}|${range.to}`);
  const apply = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setRange(draft);
  };
  return (
    <section>
      <h1>Deletion coverage</h1>
      <form method="post" className="inline" onSubmit={apply}>
        <label>
          From (UTC)
          <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label>
          To (UTC, inclusive)
          <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <button type="submit">Apply</button>
      </form>
      {res.state === "loading" ? <Loading /> : null}
      {res.state === "error" ? <ErrorNote error={res.error} /> : null}
      {res.state === "ready" ? <ReportView key={`${range.from}|${range.to}`} report={res.data} range={range} /> : null}
    </section>
  );
}

function ReportView(props: { report: Report; range: { from: string; to: string } }) {
  const r = props.report;
  const [more, setMore] = useState<{ failures: Report["failures"]; cursor: string | null }>({ failures: [], cursor: r.failuresCursor });
  const [error, setError] = useState<unknown>(null);
  const loadMore = async () => {
    try {
      const next = await getReport(...windowOf(props.range), more.cursor);
      setMore({ failures: [...more.failures, ...next.failures], cursor: next.failuresCursor });
    } catch (e) {
      setError(e);
    }
  };
  const failures = [...r.failures, ...more.failures];
  return (
    <>
      <p className="headline">
        <strong>{r.coverage.display}</strong> coverage: {r.coverage.cleanPairs} of {r.coverage.applicablePairs} applicable asset pairs verified clean, over {r.requests.total} request(s).
      </p>
      <p className="muted">
        By status: {Object.entries(r.requests.byStatus).map(([s, n]) => `${s.replace(/_/g, " ")} ${n}`).join(", ") || "none"}. Held: {r.held.requests} request(s), {r.held.assetPairs} asset pair(s). Aggregates
        recomputed: {r.aggregateRecompute.recomputed}, not recomputed: {r.aggregateRecompute.notRecomputed}.
      </p>
      <h2>By category</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Coverage</th>
              <th scope="col">Clean</th>
              <th scope="col">Applicable</th>
              <th scope="col">Not present</th>
              <th scope="col">Aggregate recompute</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(r.byCategory).map(([cat, c]) => (
              <tr key={cat}>
                <td>{cat.replace(/_/g, " ")}</td>
                <td>{c.display}</td>
                <td>{c.cleanPairs}</td>
                <td>{c.applicablePairs}</td>
                <td>{c.notPresent}</td>
                <td>{c.aggregateRecompute}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Residuals</h2>
      {r.residuals.length === 0 ? (
        <p className="note muted">None.</p>
      ) : (
        <ul>
          {r.residuals.map((x) => (
            <li key={`${x.kind}|${x.state}|${x.evidence}`}>
              {x.kind.replace(/_/g, " ")}: {x.n} {x.state} ({x.evidence})
            </li>
          ))}
        </ul>
      )}
      <h2>Failures</h2>
      {failures.length === 0 ? (
        <p className="note muted">No failed request in this window.</p>
      ) : (
        <ul className="failures">
          {failures.map((f) => (
            <li key={`${f.requestId}|${f.assetId}`}>
              <Link to={hrefFor({ page: "request", id: f.requestId })}>{shortRef(f.requestId)}</Link> <code>{f.assetId}</code>
              <pre>{JSON.stringify(f.findings)}</pre>
            </li>
          ))}
        </ul>
      )}
      {error ? <ErrorNote error={error} /> : null}
      {more.cursor ? (
        <button type="button" onClick={() => void loadMore()}>
          More failures
        </button>
      ) : null}
    </>
  );
}
