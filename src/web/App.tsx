// The privacy console: one shell for every persona. It asks /api/v1/me who the caller is and shows only the pages
// of that persona's purposes; the Worker's PDP decides every call again, so hiding a page is convenience, not control.
import { useState, type ReactNode } from "react";
import { ACCESS_LOGOUT, ApiError, devLogin, devLogout, getDevPrincipals, getMe, type Me, type Purpose } from "./api.ts";
import { AuditPage } from "./pages/AuditPage.tsx";
import { EmployeesPage } from "./pages/EmployeesPage.tsx";
import { HoldsPage } from "./pages/HoldsPage.tsx";
import { MePage } from "./pages/MePage.tsx";
import { ProfilePage } from "./pages/ProfilePage.tsx";
import { ReportPage } from "./pages/ReportPage.tsx";
import { RequestDetailPage } from "./pages/RequestDetailPage.tsx";
import { RequestsPage } from "./pages/RequestsPage.tsx";
import { DATA_PURPOSES, hrefFor, parseRoute, usePathname, type Route } from "./router.ts";
import { PERSONA_LABELS, PURPOSE_LABELS } from "./labels.ts";
import { ErrorNote, Link, Loading, useAsync } from "./ui.tsx";

/** The purpose a page needs; null for the home page. */
export function purposeOf(r: Route): Purpose | null {
  switch (r.page) {
    case "employees":
    case "profile":
      return r.purpose;
    case "requests":
    case "request":
    case "report":
    case "audit":
      return "privacy_compliance";
    case "holds":
      return "legal_hold_management";
    default:
      return null;
  }
}

type Session = { kind: "signed_in"; me: Me; local: boolean } | { kind: "signed_out"; local: boolean } | { kind: "human_only" };

async function loadSession(): Promise<Session> {
  try {
    const me = await getMe();
    const local = (await getDevPrincipals()) !== null;
    return { kind: "signed_in", me, local };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return { kind: "signed_out", local: (await getDevPrincipals()) !== null };
    if (e instanceof ApiError && e.status === 403 && e.code === "human_only") return { kind: "human_only" };
    throw e;
  }
}

export function App() {
  const [nonce, setNonce] = useState(0);
  const [session] = useAsync(loadSession, String(nonce));
  const refresh = () => setNonce((n) => n + 1);
  if (session.state === "loading") return <Frame><Loading /></Frame>;
  if (session.state === "error") return <Frame><ErrorNote error={session.error} /></Frame>;
  const s = session.data;
  if (s.kind === "human_only") return <Frame><p className="note">This console is for people. Service tokens use the API directly.</p></Frame>;
  if (s.kind === "signed_out") return <Frame>{s.local ? <DevSignIn onSignedIn={refresh} /> : <AccessSignIn />}</Frame>;
  return <Shell me={s.me} local={s.local} onSignedOut={refresh} />;
}

function Frame(props: { children: ReactNode; nav?: ReactNode; account?: ReactNode }) {
  return (
    <div className="app">
      <header className="top">
        <Link to="/" className="brand">
          PeopleVault
        </Link>
        {props.nav}
        <div className="account">{props.account}</div>
      </header>
      <main>{props.children}</main>
    </div>
  );
}

function AccessSignIn() {
  return (
    <section>
      <h1>Signed out</h1>
      <p>This console is behind Cloudflare Access. Reload the page to sign in with your organization account.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </section>
  );
}

function DevSignIn(props: { onSignedIn: () => void }) {
  const [principals] = useAsync(async () => ((await getDevPrincipals()) ?? []).filter((p) => p.kind === "human" && p.status === "active"), "dev");
  const [error, setError] = useState<unknown>(null);
  const signIn = async (id: string) => {
    try {
      await devLogin(id);
      props.onSignedIn();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section>
      <h1>Local sign-in</h1>
      <p className="muted">Local development only (AUTH_MODE=local-jwks on a loopback host): pick a fixture principal. Production signs in through Cloudflare Access.</p>
      {error ? <ErrorNote error={error} /> : null}
      {principals.state === "loading" ? <Loading /> : null}
      {principals.state === "error" ? <ErrorNote error={principals.error} /> : null}
      {principals.state === "ready" ? (
        <ul className="principals">
          {principals.data.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => void signIn(p.id)}>
                {p.id}
              </button>
              <span className="muted">{p.persona ? PERSONA_LABELS[p.persona] : ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Nav(props: { me: Me }) {
  const has = (p: Purpose) => props.me.purposes.includes(p);
  return (
    <nav aria-label="Main">
      {DATA_PURPOSES.filter(has).map((p) => (
        <Link key={p} to={hrefFor({ page: "employees", purpose: p })}>
          {PURPOSE_LABELS[p]}
        </Link>
      ))}
      {has("privacy_compliance") ? (
        <>
          <Link to={hrefFor({ page: "requests" })}>Deletion requests</Link>
          <Link to={hrefFor({ page: "report" })}>Coverage report</Link>
          <Link to={hrefFor({ page: "audit" })}>Audit log</Link>
        </>
      ) : null}
      {has("legal_hold_management") ? <Link to={hrefFor({ page: "holds" })}>Legal holds</Link> : null}
    </nav>
  );
}

function Shell(props: { me: Me; local: boolean; onSignedOut: () => void }) {
  const route = parseRoute(usePathname());
  const signOut = async () => {
    if (!props.local) {
      window.location.assign(ACCESS_LOGOUT);
      return;
    }
    await devLogout().catch(() => null);
    props.onSignedOut();
  };
  const account = (
    <>
      <span title={props.me.principalId}>{PERSONA_LABELS[props.me.persona]}</span>
      <button type="button" className="link" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
  const purpose = purposeOf(route);
  let page: ReactNode;
  if (purpose && !props.me.purposes.includes(purpose)) {
    page = (
      <p className="note" role="alert">
        Your persona ({PERSONA_LABELS[props.me.persona]}) has no access to {PURPOSE_LABELS[purpose]}.
      </p>
    );
  } else {
    page = (
      <>
        {purpose ? <p className="purpose">Purpose: {PURPOSE_LABELS[purpose]}. Every read and change is recorded in the audit log.</p> : null}
        {renderPage(route, props.me)}
      </>
    );
  }
  return (
    <Frame nav={<Nav me={props.me} />} account={account}>
      {page}
    </Frame>
  );
}

function renderPage(route: Route, me: Me): ReactNode {
  switch (route.page) {
    case "me":
      return <MePage me={me} />;
    case "employees":
      return <EmployeesPage key={route.purpose} purpose={route.purpose} />;
    case "profile":
      return <ProfilePage purpose={route.purpose} refId={route.ref} />;
    case "requests":
      return <RequestsPage />;
    case "request":
      return <RequestDetailPage id={route.id} />;
    case "holds":
      return <HoldsPage />;
    case "report":
      return <ReportPage />;
    case "audit":
      return <AuditPage />;
    case "not_found":
      return <p className="note">Page not found.</p>;
  }
}
