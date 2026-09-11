import { getSetting, setSetting } from "@/lib/server/db";
import { getValidCodexToken } from "@/lib/server/ai/vendor/codex-auth-runtime";
import { AI_MODELS, DEFAULT_AI_MODEL, type AiModel } from "@/lib/types";

// What the app knows about the models it can run on. The CATALOGUE (which models the
// account may actually use, who owns them, when they appeared) belongs to OpenAI, so it
// is fetched from there on demand and cached — never invented here. Between refreshes the
// table still works: it shows the app's own list and says the rest is unknown.

const CATALOGUE_KEY = "ai.model_catalogue";

export type CatalogueEntry = {
  id: string;
  /** Human name, when the source gives one (the ChatGPT catalogue does). */
  title: string;
  description: string;
  /** Context window, when reported. */
  maxTokens: number;
  ownedBy: string;
  createdAt: number;
};

export type StoredCatalogue = {
  fetchedAt: number;
  /** Where the list came from: the ChatGPT subscription or the platform API key. */
  source: string;
  entries: CatalogueEntry[];
};

export function storedCatalogue(): StoredCatalogue | null {
  const raw = String(getSetting(CATALOGUE_KEY) || "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredCatalogue;
    return Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

// Two shapes answer this question. The platform API returns {data:[{id, owned_by,
// created}]}; the ChatGPT backend returns {models:[{slug, title, description,
// max_tokens}]}. Both are read here rather than assuming either one.
type RawModel = {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  max_tokens?: unknown;
  owned_by?: unknown;
  created?: unknown;
};
type RawModelList = { data?: RawModel[] };

function toEntries(body: RawModelList): CatalogueEntry[] {
  return (body.data || [])
    .map((row) => ({
      id: String(row?.id || row?.slug || ""),
      title: String(row?.title || ""),
      description: String(row?.description || ""),
      maxTokens: Number(row?.max_tokens || 0),
      ownedBy: String(row?.owned_by || ""),
      // The platform API reports seconds since the epoch; store milliseconds like every
      // other date in this app.
      createdAt: Number(row?.created || 0) * 1000,
    }))
    .filter((entry) => entry.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchFromApiKey(apiKey: string): Promise<CatalogueEntry[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `A OpenAI recusou o pedido (HTTP ${res.status})${body ? `: ${body.slice(0, 160)}` : ""}`,
    );
  }
  return toEntries((await res.json()) as RawModelList);
}

// A subscription token is scoped to the Codex backend, so there is no single guaranteed
// catalogue endpoint. These are tried in order and the first one that answers wins; if
// none does, the statuses are reported rather than guessed at.
const SUBSCRIPTION_ENDPOINTS = [
  "https://chatgpt.com/backend-api/codex/models",
  "https://chatgpt.com/backend-api/models",
  "https://api.openai.com/v1/models",
];

async function fetchFromSubscription(): Promise<CatalogueEntry[]> {
  const token = await getValidCodexToken();
  const tried: string[] = [];
  for (const url of SUBSCRIPTION_ENDPOINTS) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token.access}`,
        "User-Agent": "LegalAssistant",
        ...(token.accountId ? { "ChatGPT-Account-Id": token.accountId } : {}),
      },
      cache: "no-store",
    }).catch(() => null);
    if (!res) {
      tried.push(`${new URL(url).pathname} (sem resposta)`);
      continue;
    }
    if (!res.ok) {
      tried.push(`${new URL(url).pathname} → HTTP ${res.status}`);
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as RawModelList & {
      models?: RawModelList["data"];
    };
    // The ChatGPT backend answers with `models`, the platform API with `data`.
    const entries = toEntries({ data: body.data || body.models || [] });
    if (entries.length) return entries;
    tried.push(`${new URL(url).pathname} (lista vazia)`);
  }
  throw new Error(
    `A subscrição ChatGPT não expõe um catálogo de modelos (${tried.join("; ")}). ` +
      "A tabela mostra a lista que a aplicação suporta; para obter disponibilidade e datas, " +
      "configure uma API key da OpenAI em LEGAL_OPENAI_API_KEY.",
  );
}

/**
 * Refresh the catalogue from OpenAI, using whichever credential this deployment has. The
 * subscription is the primary path (it is what analyses run on); a platform API key is
 * the fallback. Returns what was stored so the caller can render it immediately.
 */
export async function refreshCatalogue(): Promise<StoredCatalogue> {
  const apiKey = String(process.env.LEGAL_OPENAI_API_KEY || "").trim();
  let entries: CatalogueEntry[];
  let source: string;
  try {
    entries = await fetchFromSubscription();
    source = "Subscrição ChatGPT";
  } catch (subscriptionError) {
    if (!apiKey) throw subscriptionError;
    entries = await fetchFromApiKey(apiKey);
    source = "OpenAI Platform (API key)";
  }
  const catalogue: StoredCatalogue = { fetchedAt: Date.now(), source, entries };
  setSetting(CATALOGUE_KEY, JSON.stringify(catalogue));
  return catalogue;
}

export type ModelRow = {
  id: AiModel;
  isDefault: boolean;
  isSelected: boolean;
  /** true/false once a catalogue has been fetched; null while nothing is known. */
  availableToAccount: boolean | null;
  title: string;
  description: string;
  maxTokens: number;
  ownedBy: string;
  createdAt: number;
};

/**
 * Whether the fetched catalogue is even in the same namespace as the models this app
 * runs. The ChatGPT account catalogue lists web slugs (gpt-5-6-thinking); analyses run on
 * Codex ids (gpt-5.6-sol). When nothing matches, availability is UNKNOWN — reporting
 * "não listado" for a model that demonstrably works would be a lie in the other
 * direction.
 */
export function catalogueCoversAppModels(): boolean {
  const catalogue = storedCatalogue();
  if (!catalogue) return false;
  const ids = new Set(catalogue.entries.map((entry) => catalogueKey(entry.id)));
  return AI_MODELS.some((id) => ids.has(id));
}

/**
 * The catalogue lists this app's models with a `-wm` suffix (`gpt-5.6-sol-wm`), alongside
 * web slugs in a different namespace entirely (`gpt-5-6-thinking`). Stripping the suffix is
 * what makes availability answerable at all — without it every lookup missed and the whole
 * table reported "unknown" for models the account demonstrably has.
 */
function catalogueKey(id: string): string {
  return id.replace(/-wm$/, "");
}

/** The table the settings page shows: the app's models, enriched with what OpenAI said. */
export function modelRows(selected: string): ModelRow[] {
  const catalogue = storedCatalogue();
  const comparable = catalogueCoversAppModels();
  const byId = new Map(
    (catalogue?.entries || []).map((entry) => [catalogueKey(entry.id), entry]),
  );
  return AI_MODELS.map((id) => {
    const entry = byId.get(id);
    return {
      id,
      isDefault: id === DEFAULT_AI_MODEL,
      isSelected: id === selected,
      availableToAccount: catalogue && comparable ? Boolean(entry) : null,
      title: entry?.title || "",
      description: entry?.description || "",
      maxTokens: entry?.maxTokens || 0,
      ownedBy: entry?.ownedBy || "",
      createdAt: entry?.createdAt || 0,
    };
  });
}

/** Everything the account's catalogue reports that this app does not itself offer. */
export function extraCatalogueEntries(): CatalogueEntry[] {
  const catalogue = storedCatalogue();
  if (!catalogue) return [];
  const known = new Set<string>(AI_MODELS);
  return catalogue.entries.filter(
    (entry) => !known.has(catalogueKey(entry.id)),
  );
}
