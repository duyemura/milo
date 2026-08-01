import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { ClientsPage } from "./pages/ClientsPage.tsx";
import { BuildsPage } from "./pages/BuildsPage.tsx";
import { SiteDetailPage } from "./pages/SiteDetailPage.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route path="/builds" element={<BuildsPage />} />
        <Route path="/sites/:id" element={<SiteDetailPage />} />
        <Route path="/sites/:id/briefs" element={<SiteDetailPage />} />
        <Route path="/sites/:id/signals" element={<SiteDetailPage />} />
        <Route path="/sites/:id/preview" element={<SiteDetailPage />} />
        <Route path="/sites/:id/versions" element={<SiteDetailPage />} />
        <Route path="*" element={<p className="muted">Not found.</p>} />
      </Route>
    </Routes>
  );
}
