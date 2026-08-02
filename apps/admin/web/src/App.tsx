import { Link, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage.tsx";
import { WorkbenchPage } from "./pages/WorkbenchPage.tsx";

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link className="brand" to="/">Milo workbench</Link>
        <a className="signout" href="/auth/logout">Sign out</a>
      </header>
      <Routes>
        <Route index element={<HomePage />} />
        <Route path="/sites/:id" element={<WorkbenchPage />} />
        <Route path="*" element={<p className="muted">Not found.</p>} />
      </Routes>
    </div>
  );
}
