"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { MsGraphCard } from "@/components/settings/msgraph-card";
import { Card, PageHeader } from "@/components/ui/page";
import {
  modelGuidance,
  USAGE_LOAD_LABELS,
  USAGE_LOAD_PILLS,
} from "@/lib/model-guidance";

// Settings: the ChatGPT subscription connection (the AI runs on it), model selection, and
// system health. The connect flow is the same one the team already operates on the agent
// host — browser OAuth with a device-code alternative for headless/remote setups.

type OpenAiStatus = {
  authenticated: boolean;
  email?: string | null;
  displayName?: string | null;
};

type UsageWindow = {
  usedPercent: number;
  remainingPercent: number;
  resetAt: number;
};

type PlanUsage = {
  planType?: string;
  primaryWindow?: UsageWindow;
  secondaryWindow?: UsageWindow;
};

type HealthRow = {
  name: string;
  status: "ok" | "not_configured" | "degraded";
  detail: string;
};

type PendingConnect =
  | { method: "browser"; authState: string }
  | {
      method: "device";
      pollId: string;
      userCode: string;
      verificationUrl: string;
    };

const STATUS_LABELS: Record<HealthRow["status"], string> = {
  ok: "OK",
  not_configured: "Not set up",
  degraded: "Degraded",
};

const STATUS_PILLS: Record<HealthRow["status"], string> = {
  ok: "ui-pill-ok",
  not_configured: "ui-pill-info",
  degraded: "ui-pill-warn",
};

type ModelRow = {
  id: string;
  isDefault: boolean;
  isSelected: boolean;
  availableToAccount: boolean | null;
  title: string;
  description: string;
  maxTokens: number;
  ownedBy: string;
  createdAt: number;
};

type CatalogueEntry = {
  id: string;
  title: string;
  description: string;
  maxTokens: number;
};

export function SettingsView({ userName }: { userName: string }) {
  const [status, setStatus] = useState<OpenAiStatus | null>(null);
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelRows, setModelRows] = useState<ModelRow[]>([]);
  const [extras, setExtras] = useState<CatalogueEntry[]>([]);
  const [catalogue, setCatalogue] = useState<{
    fetchedAt: number;
    source: string;
  } | null>(null);
  const [comparable, setComparable] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [catalogueError, setCatalogueError] = useState("");
  const [selected, setSelected] = useState("");
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [pending, setPending] = useState<PendingConnect | null>(null);
  const [error, setError] = useState("");
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const [statusRes, modelRes, healthRes] = await Promise.all([
      fetch("/api/auth/openai/status").then((r) => r.json()),
      fetch("/api/settings/model").then((r) => r.json()),
      fetch("/api/health").then((r) => r.json()),
    ]);
    if (statusRes.ok) setStatus(statusRes);
    if (modelRes.ok) {
      setModels(modelRes.models || []);
      setSelected(modelRes.selected || "");
      setModelRows(modelRes.rows || []);
      setExtras(modelRes.extras || []);
      setCatalogue(modelRes.catalogue || null);
      setComparable(Boolean(modelRes.comparable));
    }
    if (healthRes.ok) setHealth(healthRes.rows || []);
    if (statusRes.ok && statusRes.authenticated) {
      const usageRes = await fetch("/api/auth/openai/usage")
        .then((r) => r.json())
        .catch(() => null);
      setUsage(usageRes?.ok ? usageRes.usage : null);
    } else {
      setUsage(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  function beginPolling(current: PendingConnect) {
    stopPolling();
    pollTimer.current = setInterval(async () => {
      const url =
        current.method === "browser"
          ? `/api/auth/openai/browser/poll?state=${encodeURIComponent(current.authState)}`
          : `/api/auth/openai/device/poll?pollId=${encodeURIComponent(current.pollId)}`;
      const data = await fetch(url)
        .then((r) => r.json())
        .catch(() => null);
      if (!data) return;
      if (data.status === "authorized") {
        stopPolling();
        setPending(null);
        await refresh();
      } else if (data.status === "error") {
        stopPolling();
        setPending(null);
        setError(data.error || "Authorization failed.");
      }
    }, 3000);
  }

  async function connect(method: "browser" | "device") {
    setError("");
    const data = await fetch("/api/auth/openai/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method }),
    }).then((r) => r.json());
    if (!data.ok) {
      setError(data.error || "Could not start the connection.");
      return;
    }
    if (data.method === "browser") {
      const next: PendingConnect = {
        method: "browser",
        authState: data.authState,
      };
      setPending(next);
      beginPolling(next);
      window.open(data.authorizationUrl, "_blank", "noopener");
    } else {
      const next: PendingConnect = {
        method: "device",
        pollId: data.pollId,
        userCode: data.userCode,
        verificationUrl: data.verificationUrl,
      };
      setPending(next);
      beginPolling(next);
    }
  }

  async function disconnect() {
    await fetch("/api/auth/openai/logout", { method: "POST" });
    await refresh();
  }

  async function refreshModels() {
    setRefreshingModels(true);
    setCatalogueError("");
    try {
      const data = await fetch("/api/settings/model/refresh", {
        method: "POST",
      }).then((r) => r.json());
      if (data.ok) {
        setModelRows(data.rows || []);
        setExtras(data.extras || []);
        setCatalogue(data.catalogue || null);
        setComparable(Boolean(data.comparable));
      } else {
        setCatalogueError(
          data.error || "Não foi possível obter o catálogo de modelos.",
        );
      }
    } finally {
      setRefreshingModels(false);
    }
  }

  async function pickModel(model: string) {
    setSelected(model);
    await fetch("/api/settings/model", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    await refresh();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Settings" description={`Signed in as ${userName}.`} />
      <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto pr-1 xl:grid-cols-2">
        <Card>
          <h2 className="m-0 text-xl font-semibold text-ink0">
            ChatGPT connection
          </h2>
          <p className="mt-1.5 mb-5 text-base ui-text-muted">
            The AI runs on a ChatGPT Plus/Pro subscription. Connect the account
            this deployment should use.
          </p>

          {status?.authenticated ? (
            <div className="grid gap-4">
              <p className="m-0 text-base">
                <span className="ui-pill-ok mr-2 rounded-md px-2 py-0.5 text-sm">
                  Connected
                </span>
                {status.displayName || status.email || "ChatGPT account"}
                {status.email && status.displayName ? ` · ${status.email}` : ""}
              </p>
              {usage?.primaryWindow || usage?.secondaryWindow ? (
                <div className="grid gap-3">
                  {usage.primaryWindow ? (
                    <UsageBar
                      label="5-hour window"
                      window={usage.primaryWindow}
                    />
                  ) : null}
                  {usage.secondaryWindow ? (
                    <UsageBar
                      label="Weekly window"
                      window={usage.secondaryWindow}
                    />
                  ) : null}
                  {usage.planType ? (
                    <p className="m-0 text-sm ui-text-muted">
                      Plan: {usage.planType}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div>
                <button
                  type="button"
                  onClick={disconnect}
                  className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ) : pending?.method === "device" ? (
            <div className="ui-soft-panel grid gap-2 rounded-lg p-5">
              <p className="m-0 text-base">
                Open{" "}
                <a
                  href={pending.verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ui-link"
                >
                  {pending.verificationUrl}
                </a>{" "}
                and enter this code:
              </p>
              <p className="m-0 font-mono text-2xl font-medium text-ink0">
                {pending.userCode}
              </p>
              <p className="m-0 text-sm ui-text-muted">
                Waiting for authorization…
              </p>
            </div>
          ) : pending?.method === "browser" ? (
            <p className="m-0 text-base ui-text-muted">
              Complete the sign-in in the browser tab that just opened. Waiting…
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => connect("browser")}
                className="ui-btn-primary rounded-md px-4 py-2 text-base"
              >
                Connect ChatGPT
              </button>
              <button
                type="button"
                onClick={() => connect("device")}
                className="ui-btn-secondary rounded-md px-4 py-2 text-base"
              >
                Use a device code instead
              </button>
            </div>
          )}
          {error ? (
            <p className="mt-4 mb-0 text-base text-danger">{error}</p>
          ) : null}
        </Card>

        <MsGraphCard />

        {/* Full width: the model table compares five columns of prose, and squeezed into half
            the page every cell wrapped into a tall stack. */}
        <Card className="xl:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="m-0 text-xl font-semibold text-ink0">Model</h2>
              <p className="mt-1.5 mb-0 text-base ui-text-muted">
                The model every analysis stage runs on.
              </p>
            </div>
            <button
              type="button"
              onClick={refreshModels}
              disabled={refreshingModels}
              title="Ask OpenAI which models this account can use"
              className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base disabled:opacity-50"
            >
              {refreshingModels ? "A atualizar…" : "↻ Atualizar da OpenAI"}
            </button>
          </div>
          <p className="mt-2 mb-4 text-sm ui-text-muted">
            <strong className="text-ink1">Perfil</strong>,{" "}
            <strong className="text-ink1">Melhor para</strong> e{" "}
            <strong className="text-ink1">Consumo do limite</strong> são
            orientação desta aplicação, escrita para as fases por que passa uma
            análise — a OpenAI descreve todos os seus modelos com a mesma frase,
            por isso não há comparação a obter de lá.{" "}
            <strong className="text-ink1">Disponível</strong> é que vem do
            catálogo da conta.{" "}
            {catalogue
              ? `Catálogo obtido de ${catalogue.source} em ${new Date(catalogue.fetchedAt).toLocaleString("pt-PT")}.`
              : "Atualize para saber quais os modelos que a conta lista."}
            {catalogue && !comparable ? (
              <>
                {" "}
                O catálogo da conta usa identificadores próprios (ver em baixo),
                diferentes dos modelos Codex em que as análises correm — por
                isso a disponibilidade não é confirmável por aqui.
              </>
            ) : null}
          </p>
          {catalogueError ? (
            <p className="mt-0 mb-4 text-sm text-danger">{catalogueError}</p>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-base">
              <thead>
                <tr className="text-left ui-text-muted">
                  <th className="w-64 py-2 pr-3 font-medium">Modelo</th>
                  <th className="w-28 py-2 pr-3 font-medium">Disponível</th>
                  <th className="w-64 py-2 pr-3 font-medium">Perfil</th>
                  <th className="py-2 pr-3 font-medium">Melhor para</th>
                  <th className="w-32 py-2 font-medium whitespace-nowrap">
                    Consumo do limite
                  </th>
                </tr>
              </thead>
              <tbody>
                {(modelRows.length
                  ? modelRows
                  : models.map((id) => ({
                      id,
                      isDefault: false,
                      isSelected: id === selected,
                      availableToAccount: null,
                      title: "",
                      description: "",
                      maxTokens: 0,
                      ownedBy: "",
                      createdAt: 0,
                    }))
                ).map((row) => {
                  const guidance = modelGuidance(row.id);
                  return (
                    <tr
                      key={row.id}
                      onClick={() => pickModel(row.id)}
                      className={`cursor-pointer border-t border-line0 hover:bg-surface-soft ${
                        row.isSelected ? "bg-accent-soft" : ""
                      }`}
                    >
                      <td className="py-2.5 pr-3">
                        <label className="flex cursor-pointer items-center gap-2.5">
                          <input
                            type="radio"
                            name="ai-model"
                            checked={selected === row.id}
                            onChange={() => pickModel(row.id)}
                          />
                          <span className="font-mono text-base whitespace-nowrap">{row.id}</span>
                          {row.isDefault ? (
                            <span className="ui-pill-info rounded-md px-1.5 py-0.5 text-xs">
                              predefinido
                            </span>
                          ) : null}
                        </label>
                      </td>
                      <td className="py-2.5 pr-3">
                        {row.availableToAccount === null ? (
                          <span
                            className="ui-text-subtle"
                            title="Ainda não foi obtido o catálogo"
                          >
                            —
                          </span>
                        ) : row.availableToAccount ? (
                          <span className="ui-pill-ok rounded-md px-2 py-0.5 text-sm">
                            sim
                          </span>
                        ) : (
                          <span
                            className="ui-pill-warn rounded-md px-2 py-0.5 text-sm"
                            title="A OpenAI não listou este modelo para esta conta"
                          >
                            não listado
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 ui-text-muted">
                        {guidance?.profile || "—"}
                      </td>
                      <td className="py-2.5 pr-3 ui-text-muted">
                        {guidance?.bestFor || "—"}
                      </td>
                      <td className="py-2.5 whitespace-nowrap">
                        {guidance ? (
                          <span
                            className={`${USAGE_LOAD_PILLS[guidance.load]} rounded-md px-2 py-0.5 text-sm`}
                            title="Quanto este modelo gasta das janelas de utilização acima"
                          >
                            {USAGE_LOAD_LABELS[guidance.load]}
                          </span>
                        ) : (
                          <span className="ui-text-subtle">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {extras.length ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm ui-text-muted">
                Catálogo da conta: mais {extras.length} modelo(s) que esta
                aplicação não executa
              </summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <tbody>
                    {extras.map((entry) => (
                      <tr
                        key={entry.id}
                        className="border-t border-line0 align-top"
                      >
                        <td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap">
                          {entry.id}
                        </td>
                        <td className="py-1.5 pr-3 ui-text-muted">
                          {entry.title ? (
                            <span className="text-ink0">{entry.title}</span>
                          ) : null}
                          {entry.title && entry.description ? " — " : null}
                          {entry.description || (entry.title ? "" : "—")}
                        </td>
                        <td className="py-1.5 whitespace-nowrap ui-text-subtle">
                          {entry.maxTokens
                            ? `${Math.round(entry.maxTokens / 1000)}k`
                            : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </Card>

        <Card className="xl:col-span-2">
          <h2 className="m-0 mb-5 text-xl font-semibold text-ink0">
            System health
          </h2>
          <div className="grid gap-3">
            {health.map((row) => (
              <div key={row.name} className="flex flex-wrap items-center gap-3">
                <span
                  className={`${STATUS_PILLS[row.status]} rounded-md px-2 py-0.5 text-sm`}
                >
                  {STATUS_LABELS[row.status]}
                </span>
                <span className="min-w-32 font-medium text-ink0">
                  {row.name}
                </span>
                <span className="ui-text-muted">{row.detail}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function UsageBar({
  label,
  window: win,
}: {
  label: string;
  window: UsageWindow;
}) {
  const used = Math.round(win.usedPercent);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="ui-text-muted">{label}</span>
        <span className="font-mono">{used}% used</span>
      </div>
      <div className="h-2 overflow-hidden rounded-md bg-surface-soft">
        <div
          className={`h-full rounded-md ${used >= 90 ? "bg-danger" : used >= 70 ? "bg-warn" : "bg-accent"}`}
          style={{ width: `${Math.min(100, Math.max(2, used))}%` }}
        />
      </div>
      <p className="m-0 text-sm ui-text-muted">
        Resets {new Date(win.resetAt * 1000).toLocaleString()}
      </p>
    </div>
  );
}
