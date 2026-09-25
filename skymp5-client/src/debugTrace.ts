// ia-forge : canal unique des traces du client (mode débogage du gamemode, docs/76-debug.md du projet).
//
// Les traces sont empilées dans storage["gmTrace"] ({ at, cat, msg, data }) ; le script « _gmDebug » du gamemode
// les vide à chaque frame et les envoie au serveur (journal `[dbg:…]` + logs/debug/*.jsonl). Le serveur pose
// storage["gmDebug"] = { on, cats } : hors débogage, seules les erreurs sont gardées (coût nul sinon).
import { storage } from "skyrimPlatform";
import { MsgType } from "./messages";

// Signature de version du client maison (lue par le gamemode : quel client tourne chez chaque joueur).
export const CLIENT_BUILD = "ia-forge-local-13";
try {
  storage["gmClientBuild"] = CLIENT_BUILD;
} catch (e) {
  // storage indisponible
}

const MAX_QUEUE = 300;
const ALWAYS = new Set(["erreur", "marque"]);

/** La catégorie est-elle tracée en ce moment ? (pour éviter de construire des traces coûteuses) */
export const gmDebugOn = (cat: string): boolean => {
  if (ALWAYS.has(cat)) return true;
  try {
    // Clé absente : le storage de SP renvoie une fonction « piège », pas undefined (storageProxy.js).
    const d = storage["gmDebug"] as { on?: unknown; cats?: unknown };
    if (!d || typeof d !== "object" || d.on !== true) return false;
    const cats = Array.isArray(d.cats) ? (d.cats as unknown[]) : [];
    return cats.length === 0 || cats.includes(cat);
  } catch (e) {
    return false;
  }
};

export const gmTrace = (cat: string, msg: string, data?: Record<string, unknown>): void => {
  if (!gmDebugOn(cat)) return;
  try {
    const cur = storage["gmTrace"];
    const t = Array.isArray(cur) ? (cur as Array<unknown>) : [];
    const e: Record<string, unknown> = { at: Date.now(), cat, msg };
    if (data !== undefined) e.data = data;
    t.push(e);
    if (t.length > MAX_QUEUE) t.splice(0, t.length - MAX_QUEUE);
    storage["gmTrace"] = t;
  } catch (e) {
    // trace indisponible
  }
};

/** Texte court d'une valeur quelconque (erreurs avec leur pile). */
export const traceText = (v: unknown, max = 500): string => {
  let s: string;
  if (v instanceof Error) s = v.stack || v.message;
  else if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch (e) {
      s = String(v);
    }
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
};

// --- Réseau : messages rares tracés un par un, fréquents comptés (résumé toutes les 5 s) -------------
const FREQUENT = new Set<number>([
  MsgType.UpdateMovement,
  MsgType.UpdateAnimation,
  MsgType.UpdateAnimVariables,
  MsgType.ChangeValues,
  MsgType.UpdateProperty,
]);
const recvCounts = new Map<string, number>();
const sentCounts = new Map<string, number>();
let summaryAt = Date.now();

const typeName = (t: unknown): string => (typeof t === "number" && MsgType[t] ? MsgType[t] : String(t));

const maybeSummary = (): void => {
  const now = Date.now();
  if (now - summaryAt < 5000) return;
  const secs = Math.round((now - summaryAt) / 1000);
  summaryAt = now;
  if (!recvCounts.size && !sentCounts.size) return;
  const fmt = (m: Map<string, number>) => {
    const parts: string[] = [];
    m.forEach((v, k) => parts.push(`${k} ${v}`));
    return parts.join(", ") || "rien";
  };
  gmTrace("reseau", `${secs} s : reçu ${fmt(recvCounts)} ; envoyé ${fmt(sentCounts)}`);
  recvCounts.clear();
  sentCounts.clear();
};

/** Message reçu du serveur (JSON, ou binaire quand msg = null). */
export const traceRecv = (msg: { t?: unknown } | null): void => {
  if (!gmDebugOn("reseau")) return;
  const name = msg ? typeName(msg.t) : "binaire";
  if (!msg || FREQUENT.has(msg.t as number)) {
    recvCounts.set(name, (recvCounts.get(name) || 0) + 1);
  } else {
    gmTrace("reseau", `reçu ${name}`, { m: traceText(msg, 400) });
  }
  maybeSummary();
};

/** Message envoyé au serveur (comptage seulement). */
export const traceSent = (msg: { t?: unknown } | null): void => {
  if (!gmDebugOn("reseau")) return;
  const name = msg ? typeName(msg.t) : "binaire";
  sentCounts.set(name, (sentCounts.get(name) || 0) + 1);
  maybeSummary();
};
