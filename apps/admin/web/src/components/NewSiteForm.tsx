import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@pushpress/pushpress-ui";
import { api, type Company } from "../api.ts";

export function NewSiteForm({ company }: { company: Company }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ sourceUrl: "", name: "", city: "", state: "" });
  const create = useMutation({
    mutationFn: () =>
      api.createSite({
        companyId: company.id,
        seedType: "template",
        sourceUrl: form.sourceUrl.trim(),
        name: form.name.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        templateId: "modern",
      }),
    onSuccess: () => {
      setForm({ sourceUrl: "", name: "", city: "", state: "" });
      void qc.invalidateQueries({ queryKey: ["sites", company.id] });
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const ready = form.sourceUrl.trim() && form.name.trim() && form.city.trim() && form.state.trim();

  return (
    <form
      className="create site-create"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) create.mutate();
      }}
    >
      <span className="muted small">New template site (crawls the gym and builds):</span>
      <Input value={form.sourceUrl} onChange={set("sourceUrl")} placeholder="https://thegym.com" />
      <Input value={form.name} onChange={set("name")} placeholder="Gym name" />
      <Input value={form.city} onChange={set("city")} placeholder="City" />
      <Input value={form.state} onChange={set("state")} placeholder="State (CO)" />
      <Button type="submit" disabled={create.isPending || !ready}>
        Create site
      </Button>
      {create.error && <p className="error">{create.error.message}</p>}
    </form>
  );
}
