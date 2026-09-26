import { useEffect, useMemo, useRef, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { CheckoutElementsProvider, ExpressCheckoutElement, PaymentElement, useCheckoutElements } from "@stripe/react-stripe-js/checkout";
import LandingPage from "./Landing.jsx";
import JSZip from "jszip";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { oneDark } from "@codemirror/theme-one-dark";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import "./minecraft.css";
import "./minecraft-extensions.css";
import "./marketplace-filters.css";
import "./marketplace-detail.css";
import "./minecraft-wizard.css";
import "./minecraft-progress.css";
import "./creation-fix.css";
import "./stripe-checkout.css";
import {
  Activity,
  ArrowLeft,
  Bot,
  Brain,
  Box,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  Cpu,
  CreditCard,
  Database,
  Eye,
  EyeOff,
  Flag,
  FileCode2,
  FileArchive,
  Folder,
  FolderPlus,
  Gamepad2,
  GitBranch,
  Globe2,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  LoaderCircle,
  LogOut,
  MapPin,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Network,
  Package,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Send,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  UploadCloud,
  Users,
  UserRound,
  X,
  Zap,
} from "lucide-react";

const plans = [
  { id: "mini", name: "Mini", cpu: 0.5, ram: 2, disk: 20, price: 1 },
  {
    id: "basic",
    name: "Basic",
    cpu: 1,
    ram: 4,
    disk: 100,
    price: 5,
    popular: true,
  },
  { id: "pro", name: "Pro", cpu: 2, ram: 6, disk: 200, price: 10 },
  {
    id: "enterprise",
    name: "Enterprise",
    cpu: 4,
    ram: 12,
    disk: 500,
    price: 20,
  },
];
const templates = [
  { id: "minecraft", name: "Minecraft Server" },
  { id: "ubuntu", name: "Ubuntu 24.04" },
  { id: "node", name: "Node.js + Nginx" },
  { id: "nginx", name: "Nginx Webserver" },
  { id: "python", name: "Python API" },
];
const minecraftLoaders = [
  { id: "paper", name: "Paper", note: "Fast, stable and plugin-ready", tag: "Recommended" },
  { id: "vanilla", name: "Vanilla", note: "The official Minecraft server", tag: "Official" },
  { id: "purpur", name: "Purpur", note: "Performance and extra settings", tag: "Plugins" },
  { id: "fabric", name: "Fabric", note: "Lightweight modern mod loader", tag: "Mods" },
  { id: "forge", name: "Forge", note: "Classic mod loader with a huge ecosystem", tag: "Mods" },
  { id: "folia", name: "Folia", note: "Regionized multithreaded server", tag: "Advanced" },
];

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(new Error(body.error || "Server error"), {
      status: response.status,
      body,
    });
  return body;
}
const siteDialog = ({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, input = false, inputType = "text", placeholder = "", alert = false }) => new Promise((resolve) => {
  const backdrop = document.createElement("div");
  backdrop.className = "site-dialog-backdrop";
  backdrop.innerHTML = `<section class="site-dialog" role="dialog" aria-modal="true"><header><span class="site-dialog-icon"></span><div><small>VYRON</small><h2></h2></div></header><p></p><label class="site-dialog-input"><span>Confirmation</span><input /></label><footer><button class="site-dialog-cancel" type="button"></button><button class="site-dialog-confirm" type="button"></button></footer></section>`;
  const card = backdrop.querySelector(".site-dialog"), heading = card.querySelector("h2"), copy = card.querySelector("p"), fieldWrap = card.querySelector(".site-dialog-input"), field = fieldWrap.querySelector("input"), cancel = card.querySelector(".site-dialog-cancel"), confirmButton = card.querySelector(".site-dialog-confirm");
  heading.textContent = title;
  copy.textContent = message;
  fieldWrap.hidden = !input;
  field.type = inputType;
  field.placeholder = placeholder;
  cancel.textContent = cancelLabel;
  cancel.hidden = alert;
  confirmButton.textContent = alert ? "OK" : confirmLabel;
  if (danger) confirmButton.classList.add("danger");
  const finish = value => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(value); };
  const onKey = event => {
    if (event.key === "Escape") finish(input ? null : false);
    if (event.key === "Enter" && (!input || field.value.trim())) finish(input ? field.value : true);
  };
  cancel.addEventListener("click", () => finish(input ? null : false));
  confirmButton.addEventListener("click", () => { if (!input || field.value.trim()) finish(input ? field.value : true); else field.focus(); });
  backdrop.addEventListener("click", event => { if (event.target === backdrop) finish(input ? null : false); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
  window.requestAnimationFrame(() => (input ? field : confirmButton).focus());
});
const siteConfirm = options => siteDialog(options);
const sitePrompt = options => siteDialog({ ...options, input: true });
const siteAlert = options => siteDialog({ ...options, alert: true });
const stripeClients = new Map();
const stripeClient = key => {
  if (!stripeClients.has(key)) stripeClients.set(key, loadStripe(key));
  return stripeClients.get(key);
};
function StripeCompactPayment({ payment, onComplete }) {
  const checkoutState = useCheckoutElements();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [expressVisible, setExpressVisible] = useState(false);
  const completionStarted = useRef(false);
  if (checkoutState.type === "loading") return <div className="stripe-form-loading"><LoaderCircle className="spin" /> Loading secure payment…</div>;
  if (checkoutState.type === "error") return <div className="vh-error">{checkoutState.error.message}</div>;
  const finish = async (args = {}) => {
    if (completionStarted.current) return;
    completionStarted.current = true; setBusy(true); setError("");
    try {
      const result = await checkoutState.checkout.confirm({ redirect: "if_required", ...args });
      if (result.type === "error") throw new Error(result.error.message || "Payment could not be completed.");
      await onComplete();
    } catch (checkoutError) {
      completionStarted.current = false; setBusy(false); setError(checkoutError.message || "Payment could not be completed.");
    }
  };
  return <form className="stripe-compact-form" onSubmit={(event) => { event.preventDefault(); void finish(); }}>
    <div className={expressVisible ? "stripe-express visible" : "stripe-express"}>
      <ExpressCheckoutElement
        options={{ buttonHeight: 46, buttonType: { paypal: "paypal" }, buttonTheme: { paypal: "gold" }, layout: { maxColumns: 1, maxRows: 1, overflow: "never" }, paymentMethodOrder: ["paypal"], paymentMethods: { paypal: "auto", amazonPay: "never", applePay: "never", googlePay: "never", link: "never", klarna: "never" } }}
        onReady={({ availablePaymentMethods }) => setExpressVisible(Boolean(availablePaymentMethods?.paypal))}
        onConfirm={(event) => void finish({ expressCheckoutConfirmEvent: event })}
      />
    </div>
    {expressVisible && <div className="stripe-divider"><span>or pay with card</span></div>}
    <PaymentElement options={{ layout: "accordion", paymentMethodOrder: ["card"] }} />
    {error && <div className="vh-error">{error}</div>}
    <button className="stripe-pay-button" disabled={busy} type="submit">{busy ? <><LoaderCircle className="spin" /> Processing…</> : `Pay ${Number(payment.total || 0).toFixed(2)} ${payment.currency || "EUR"}`}</button>
  </form>;
}
function StripeCheckoutModal({ payment, title, onComplete, onClose }) {
  const options = useMemo(() => ({
    clientSecret: payment.clientSecret,
    elementsOptions: { appearance: { theme: "night", variables: { colorPrimary: "#7c5ce7", colorBackground: "#17171b", colorText: "#f4f2f7", colorDanger: "#ff7188", borderRadius: "9px", fontFamily: "Inter, system-ui, sans-serif", spacingUnit: "3px" } } },
  }), [payment.clientSecret]);
  return <div className="vh-modal-bg stripe-checkout-bg"><section className="stripe-checkout-modal compact"><header><div><small>STRIPE TEST MODE</small><h2>{title}</h2><p>Choose PayPal or enter your card details.</p></div><button onClick={onClose} aria-label="Close"><X /></button></header><div className="stripe-test-banner"><ShieldCheck /> Test payment — no real money will be charged</div><div className="stripe-embedded-shell"><CheckoutElementsProvider stripe={stripeClient(payment.publishableKey)} options={options}><StripeCompactPayment payment={payment} onComplete={onComplete} /></CheckoutElementsProvider></div><footer><span><LockKeyhole /> Secured by Stripe</span><b>TEST MODE</b></footer></section></div>;
}
const nodeStatusLabel = (status, minecraft) => {
  if (["queued", "provisioning"].includes(status)) return "Creating";
  if (status === "running" && minecraft) return ["running", "stopped", "failed"].includes(minecraft.status) ? minecraft.status : "Creating";
  return status;
};
const confirmNodeDeletion = async (name) => {
  const phrase = `DELETE ${name}`;
  const entered = await sitePrompt({ title: `Delete ${name}?`, message: `This permanently removes the real server and cannot be undone. Type ${phrase} to confirm.`, placeholder: phrase, confirmLabel: "Delete server", danger: true });
  if (entered === null) return false;
  if (entered !== phrase) {
    await siteAlert({ title: "Deletion cancelled", message: `Enter exactly: ${phrase}` });
    return false;
  }
  return true;
};
function Brand() {
  return (
    <a className="vh-brand" href="/">
      <span>
        <i />
      </span>
      <strong>vyron</strong>
    </a>
  );
}
function LoadingScreen() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 3000);
    return () => window.clearTimeout(timer);
  }, []);
  return <div className="vh-loading"><Brand /><span />{slow && <div className="vh-loading-status"><small>Taking longer than expected?</small><a href="https://status.vyronpanel.com" target="_blank" rel="noreferrer"><Activity />Check status</a></div>}</div>;
}
const legalDocuments = {
  terms: {
    eyebrow: "LEGAL · VERSION 2026-09-08",
    title: "Allgemeine Geschäftsbedingungen",
    intro: "Diese AGB regeln die Nutzung der Hosting-, Node-, Domain- und Verwaltungsdienste von Vyron Technologies.",
    sections: [
      ["1. Anbieter und Geltungsbereich", "Anbieter ist Vyron Technologies. Vor dem kommerziellen Start müssen hier die vollständige Firmierung, die ladungsfähige Anschrift, Vertretungsberechtigte sowie gegebenenfalls Register- und Umsatzsteuerdaten ergänzt werden. Diese AGB gelten für alle Verträge über die Vyron-Plattform."],
      ["2. Vertragsschluss", "Die Darstellung von Tarifen ist kein bindendes Angebot. Der Kunde gibt mit dem Abschluss der Bestellung ein Angebot ab. Der Vertrag entsteht mit der Bestellbestätigung oder Bereitstellung des Nodes. Eingabefehler können vor der Bestellung korrigiert werden."],
      ["3. Leistungen und Ressourcen", "Der konkrete Leistungsumfang ergibt sich aus dem gewählten Tarif. CPU-, RAM-, Speicher-, Netzwerk- und GPU-Ressourcen sind technische Obergrenzen. Wartungen, Sicherheitsmaßnahmen und technisch notwendige Änderungen bleiben zulässig, sofern die vertragsgemäße Nutzung nicht unangemessen beeinträchtigt wird."],
      ["4. Preise und Zahlung", "Es gelten die im Checkout angezeigten Preise und Abrechnungsintervalle. Zahlungen werden über den Zahlungsdienstleister Stripe abgewickelt. Kostenlose Coupons gelten nur für die jeweils ausgewiesenen Tarife und Zeiträume."],
      ["5. Pflichten der Kunden", "Zugangsdaten sind geheim zu halten und Systeme angemessen zu sichern. Kunden sind für Inhalte, Backups und die Rechtmäßigkeit ihrer Nutzung verantwortlich. Untersagt sind insbesondere Angriffe, Schadsoftware, Phishing, Spam, rechtswidrige Inhalte, Missbrauch fremder Ressourcen sowie Handlungen, die Infrastruktur oder Dritte gefährden."],
      ["6. Sperrung und Sicherheitsmaßnahmen", "Vyron darf betroffene Dienste bei konkreten Sicherheitsrisiken, Zahlungsverzug oder erheblichen Rechts- bzw. Vertragsverstößen vorübergehend sperren. Soweit möglich, wird der Kunde vorher informiert und erhält Gelegenheit zur Abhilfe."],
      ["7. Domains und Drittanbieter", "Domains, DNS, Tunnel, GitHub, Cloudflare, OpenRouter und andere Integrationen können von Drittanbietern abhängen. Deren Verfügbarkeit und Bedingungen liegen außerhalb des unmittelbaren Einflusses von Vyron."],
      ["8. Verfügbarkeit, Wartung und Backups", "Eine ununterbrochene Verfügbarkeit wird nur zugesagt, wenn sie im Tarif ausdrücklich vereinbart ist. Geplante Wartungen und Störungen werden nach Möglichkeit über die Statusseite veröffentlicht. Kunden müssen wichtige Daten zusätzlich selbst sichern, sofern kein gesonderter Backup-Tarif vereinbart wurde."],
      ["9. Laufzeit und Kündigung", "Laufzeit, Verlängerung und Kündigungsfrist ergeben sich aus dem Checkout. Das Recht zur außerordentlichen Kündigung bleibt bestehen. Nach Vertragsende können Nodes und gespeicherte Daten gelöscht werden; notwendige Exporte sind vorher vorzunehmen."],
      ["10. Widerruf für Verbraucher", "Verbrauchern kann bei Fernabsatzverträgen ein gesetzliches Widerrufsrecht zustehen. Eine gesonderte Widerrufsbelehrung und ein Muster-Widerrufsformular müssen vor dem kommerziellen Verkauf bereitgestellt werden. Der vorzeitige Leistungsbeginn erfolgt nur unter den gesetzlich erforderlichen Voraussetzungen."],
      ["11. Haftung", "Vyron haftet unbeschränkt bei Vorsatz, grober Fahrlässigkeit sowie bei Verletzung von Leben, Körper oder Gesundheit. Bei leicht fahrlässiger Verletzung wesentlicher Vertragspflichten ist die Haftung auf den typischerweise vorhersehbaren Schaden begrenzt. Zwingende gesetzliche Haftung bleibt unberührt."],
      ["12. Schlussbestimmungen", "Es gilt deutsches Recht unter Wahrung zwingender Verbraucherschutzvorschriften. Ist der Kunde Kaufmann, kann der Sitz des Anbieters als Gerichtsstand vereinbart werden. Änderungen dieser AGB werden in Textform angekündigt; für laufende Verträge gelten die gesetzlichen Voraussetzungen."],
    ],
  },
  privacy: {
    eyebrow: "PRIVACY · VERSION 2026-09-08",
    title: "Datenschutzerklärung",
    intro: "Diese Erklärung beschreibt die Verarbeitung personenbezogener Daten auf vyronhosting.com, app.vyronhosting.com und den verbundenen Hosting-Diensten.",
    sections: [
      ["1. Verantwortlicher", "Verantwortlich ist Vyron Technologies. Vor dem öffentlichen Geschäftsbetrieb müssen die vollständige Firmierung und ladungsfähige Anschrift ergänzt werden. Datenschutzkontakt: privacy@vyronhosting.com. Bitte stelle sicher, dass dieses Postfach erreichbar ist."],
      ["2. Verarbeitete Daten", "Wir verarbeiten Konto- und Kontaktdaten, Workspace- und Mitgliedschaftsdaten, Bestell- und Zahlungsmetadaten, Node- und Domainkonfigurationen, Support- und AI-Anfragen, technische Protokolle, IP-Adressen, Sicherheitsereignisse sowie Nutzungs- und Leistungsmetriken. Passwörter werden nur als kryptografische Prüfsummen gespeichert."],
      ["3. Zwecke und Rechtsgrundlagen", "Die Verarbeitung erfolgt zur Vertragsanbahnung und Vertragserfüllung (Art. 6 Abs. 1 lit. b DSGVO), zur Erfüllung gesetzlicher Pflichten (lit. c) und zur sicheren, stabilen und missbrauchsfreien Bereitstellung der Plattform auf Grundlage berechtigter Interessen (lit. f). Eine einwilligungsabhängige Verarbeitung erfolgt nur nach Einwilligung (lit. a)."],
      ["4. Hosting, Sicherheit und Protokolle", "Server- und Zugriffsdaten werden verarbeitet, um Anfragen auszuliefern, Fehler zu beheben, Kapazität zu planen und Angriffe zu erkennen. Session-Cookies sind für Anmeldung und Kontosicherheit erforderlich. Derzeit werden keine nicht notwendigen Werbe- oder Analyse-Cookies beschrieben."],
      ["5. Zahlungsabwicklung", "Bei einer Stripe-Zahlung werden die für den Vorgang erforderlichen Bestell- und Zahlungsdaten sicher an Stripe übermittelt. Das Zahlungsformular wird eingebettet, während sensible Kartendaten direkt von Stripe verarbeitet werden. Vyron speichert Bestellstatus, Betrag und externe Transaktionsreferenzen, jedoch keine vollständigen Kartendaten."],
      ["6. Infrastruktur- und Domainanbieter", "Zur Bereitstellung können Hosting- und Netzwerkdienstleister einschließlich Netcup und Cloudflare eingesetzt werden. Für verbundene Domains, Tunnel, DNS und Schutzfunktionen werden technische Verbindungs- und Konfigurationsdaten verarbeitet."],
      ["7. AI und OpenRouter", "Wenn der AI Helper verwendet wird, werden die eingegebene Frage, begrenzter Gesprächskontext und erforderliche Workspace-Metadaten an den konfigurierten AI-Anbieter OpenRouter übermittelt. Geheimnisse und Node-Passwörter sollen nicht an das Modell übertragen werden. Die Nutzung ist optional."],
      ["8. Empfänger und Drittlandtransfers", "Daten erhalten nur erforderliche Dienstleister, berechtigte Workspace-Mitglieder und Stellen, denen gegenüber eine gesetzliche Pflicht besteht. Bei Übermittlungen außerhalb des EWR werden – soweit erforderlich – Angemessenheitsbeschlüsse, Standardvertragsklauseln oder andere Garantien eingesetzt. Die konkrete Anbieterliste sollte vor dem Produktivstart abschließend dokumentiert werden."],
      ["9. Speicherdauer", "Daten werden solange gespeichert, wie das Konto oder der Vertrag besteht und anschließend nur entsprechend gesetzlicher Aufbewahrungspflichten oder berechtigter Sicherheits- und Rechtsverteidigungsinteressen. Sessiondaten laufen technisch ab; Protokolle und Backups werden nach festgelegten Löschfristen entfernt. Konkrete Fristen sind im internen Löschkonzept festzulegen."],
      ["10. Rechte betroffener Personen", "Betroffene Personen haben nach Maßgabe der DSGVO Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch sowie das Recht, Einwilligungen mit Wirkung für die Zukunft zu widerrufen. Außerdem besteht ein Beschwerderecht bei einer Datenschutzaufsichtsbehörde."],
      ["11. Erforderlichkeit und automatisierte Entscheidungen", "Für Konto, Vertrag und sichere Bereitstellung erforderliche Daten müssen angegeben werden; ohne sie ist die Leistung gegebenenfalls nicht möglich. Eine ausschließlich automatisierte Entscheidung mit rechtlicher oder ähnlich erheblicher Wirkung ist derzeit nicht vorgesehen."],
      ["12. Änderungen", "Diese Datenschutzerklärung wird angepasst, wenn sich Dienste, Anbieter oder Rechtslage ändern. Die aktuelle Version wird auf dieser Seite veröffentlicht."],
    ],
  },
};
function LegalPage({ type }) {
  const document = legalDocuments[type];
  return <div className="legal-page"><header><Brand /><nav><a className={type === "terms" ? "active" : ""} href="/terms">AGB</a><a className={type === "privacy" ? "active" : ""} href="/privacy">Datenschutz</a><a href="/">Back to Vyron</a></nav></header><main><span>{document.eyebrow}</span><h1>{document.title}</h1><p className="legal-intro">{document.intro}</p><aside><ShieldCheck /><p><b>Vor öffentlichem Verkauf vervollständigen:</b> Betreiberanschrift, Rechtsform, Register-/Steuerangaben, Widerrufsbelehrung, konkrete Löschfristen und vollständige Auftragsverarbeiter.</p></aside>{document.sections.map(([title, content]) => <section key={title}><h2>{title}</h2><p>{content}</p></section>)}<footer><a href="https://www.gesetze-im-internet.de/bgb/__305.html" target="_blank" rel="noreferrer">§ 305 BGB</a><a href="https://www.gesetze-im-internet.de/ddg/__5.html" target="_blank" rel="noreferrer">§ 5 DDG</a><a href="https://eur-lex.europa.eu/eli/reg/2016/679/oj" target="_blank" rel="noreferrer">DSGVO</a></footer></main></div>;
}
function ReportDomainPage() {
  const [domain, setDomain] = useState(""), [result, setResult] = useState(null), [category, setCategory] = useState("scam"), [details, setDetails] = useState(""), [reporterEmail, setReporterEmail] = useState(""), [busy, setBusy] = useState(""), [error, setError] = useState(""), [submitted, setSubmitted] = useState(""), [turnstileConfig, setTurnstileConfig] = useState(null), [turnstileToken, setTurnstileToken] = useState("");
  const turnstileContainer = useRef(null), turnstileWidget = useRef(null);
  useEffect(() => { api("/v1/report/config").then(setTurnstileConfig).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!result || !turnstileConfig?.turnstile?.siteKey) return;
    let active = true;
    const render = () => {
      if (!active || !turnstileContainer.current || !window.turnstile || turnstileWidget.current !== null) return;
      turnstileWidget.current = window.turnstile.render(turnstileContainer.current, { sitekey: turnstileConfig.turnstile.siteKey, theme: "dark", size: "flexible", action: "domain_report", callback: token => setTurnstileToken(token), "expired-callback": () => setTurnstileToken(""), "error-callback": () => { setTurnstileToken(""); setError("Captcha could not be loaded. Please try again."); } });
    };
    if (window.turnstile) render();
    else {
      let script = document.querySelector("script[data-vyron-turnstile]");
      if (!script) { script = document.createElement("script"); script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; script.async = true; script.defer = true; script.dataset.vyronTurnstile = "true"; document.head.appendChild(script); }
      script.addEventListener("load", render, { once: true });
    }
    return () => { active = false; if (turnstileWidget.current !== null && window.turnstile) window.turnstile.remove(turnstileWidget.current); turnstileWidget.current = null; setTurnstileToken(""); };
  }, [result?.domain, turnstileConfig?.turnstile?.siteKey]);
  const lookup = async (event) => {
    event?.preventDefault(); setBusy("search"); setError(""); setSubmitted("");
    try { setResult(await api(`/v1/report/domain?domain=${encodeURIComponent(domain)}`)); setTurnstileToken(""); }
    catch (e) { setResult(null); setError(e.message); }
    finally { setBusy(""); }
  };
  const report = async (event) => {
    event.preventDefault(); setBusy("report"); setError("");
    try {
      const response = await api("/v1/report/domain", { method: "POST", body: JSON.stringify({ domain: result.domain, category, details, reporterEmail, company: "", turnstileToken }) });
      setSubmitted(response.message); setDetails(""); setTurnstileToken(""); if (turnstileWidget.current !== null && window.turnstile) window.turnstile.reset(turnstileWidget.current);
    } catch (e) { setError(e.message); setTurnstileToken(""); if (turnstileWidget.current !== null && window.turnstile) window.turnstile.reset(turnstileWidget.current); }
    finally { setBusy(""); }
  };
  return <div className="report-page">
    <header><Brand /><nav><a href="/">Back to Vyron</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a></nav></header>
    <main>
      <div className="report-hero"><span><ShieldCheck /> VYRON TRUST & SAFETY</span><h1>Verify or report a domain.</h1><p>Check whether a website is an official Vyron service or a customer-operated service hosted on our infrastructure. Hosting does not mean endorsement.</p></div>
      <form className="report-search" onSubmit={lookup}><Search /><input required value={domain} onChange={event => setDomain(event.target.value)} placeholder="example.vyronhosting.com" autoComplete="url" /><button disabled={busy === "search"}>{busy === "search" ? "Checking…" : "Check domain"}</button></form>
      {error && <div className="vh-error">{error}</div>}
      {result && <section className={`report-result ${result.status}`}>
        <div><span>{result.status === "official" ? <ShieldCheck /> : <Globe2 />}</span><div><small>{result.domain}</small><h2>{result.label}</h2><p>{result.status === "official" ? "This hostname is reserved for an official service operated by Vyron Technologies." : result.status === "hosted" ? "This service runs on Vyron infrastructure, but its content is controlled by a customer." : "We could not match this domain to a currently active Vyron service."}</p></div></div>
        <em>{result.status === "official" ? "OFFICIAL" : result.status === "hosted" ? "CUSTOMER HOSTED" : "NOT IDENTIFIED"}</em>
      </section>}
      {result && <form className="report-form" onSubmit={report}><div><Flag /><span><h2>Report suspicious activity</h2><p>Reports are sent directly to Vyron Security for review.</p></span></div><label>Category<select value={category} onChange={event => setCategory(event.target.value)}><option value="scam">Scam or fraud</option><option value="phishing">Phishing</option><option value="malware">Malware</option><option value="spam">Spam</option><option value="other">Other abuse</option></select></label><label>What happened?<textarea required minLength="20" maxLength="1600" value={details} onChange={event => setDetails(event.target.value)} placeholder="Describe what you saw, including relevant URLs and why it looks suspicious." /></label><label>Email for follow-up <small>optional</small><input type="email" value={reporterEmail} onChange={event => setReporterEmail(event.target.value)} placeholder="you@example.com" /></label><input className="report-honeypot" tabIndex="-1" aria-hidden="true" autoComplete="off" />{turnstileConfig?.turnstile?.configured ? <div className="turnstile-wrap"><div ref={turnstileContainer} /></div> : <div className="turnstile-unavailable">Captcha is not configured yet. Reporting is temporarily unavailable.</div>}<button disabled={busy === "report" || !turnstileToken}>{busy === "report" ? "Sending securely…" : turnstileToken ? "Send report" : "Complete captcha first"}</button>{submitted && <div className="report-success"><Check /> {submitted}</div>}</form>}
      <aside className="report-note"><ShieldCheck /><span><b>Immediate danger?</b> Do not enter passwords or payment details. Leave the site and contact your bank or local authorities when appropriate.</span></aside>
    </main>
  </div>;
}
function CopyButton({ value, label = "Copy" }) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false),
    timer = useRef(null);
  const fallbackCopy = () => {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand("copy");
    textarea.remove();
    if (!success) throw new Error("Copy failed");
  };
  const copy = async () => {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          fallbackCopy();
        }
      } else {
        fallbackCopy();
      }
      setFailed(false);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setFailed(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setFailed(false), 1600);
    }
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`copy-action ${copied ? "copied" : ""} ${failed ? "failed" : ""}`}
      onClick={copy}
      disabled={!value}
      title={failed ? "Copy failed" : copied ? "Copied" : label}
      aria-label={failed ? "Copy failed" : copied ? "Copied" : label}
    >
      {copied ? <Check /> : <Copy />}
      {(copied || failed) && <span>{failed ? "Copy failed" : "Copied"}</span>}
    </button>
  );
}

function LiveGraph({ data = [], emptyText = "Collecting live metrics…" }) {
  const [hover, setHover] = useState(null),
    wrap = useRef(null),
    width = 1000,
    height = 180;
  const rows = data.slice(-120);
  const points = (key) =>
    rows
      .map(
        (row, index) =>
          `${rows.length === 1 ? width / 2 : (index / (rows.length - 1)) * width},${height - (Math.max(0, Math.min(100, row[key] || 0)) / 100) * height}`,
      )
      .join(" ");
  const move = (e) => {
    if (!rows.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    setHover(Math.round(ratio * (rows.length - 1)));
  };
  const item = hover === null ? null : rows[hover],
    x = rows.length < 2 ? 50 : (hover / (rows.length - 1)) * 100;
  return (
    <div
      className="live-graph"
      ref={wrap}
      onMouseMove={move}
      onMouseLeave={() => setHover(null)}
    >
      {rows.length ? (
        <>
          <div className="graph-lines">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            aria-label="Live resource graph"
          >
            <defs>
              <linearGradient id="liveFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#825cff" stopOpacity=".25" />
                <stop offset="1" stopColor="#825cff" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon
              className="graph-area"
              points={`0,${height} ${points("cpu")} ${width},${height}`}
            />
            <polyline className="cpu-line" points={points("cpu")} />
            <polyline className="ram-line" points={points("ram")} />
          </svg>
          {item && (
            <>
              <span className="graph-cursor" style={{ left: `${x}%` }} />
              <span
                className="graph-dot cpu"
                style={{
                  left: `${x}%`,
                  top: `${100 - Math.max(0, Math.min(100, item.cpu || 0))}%`,
                }}
              />
              <span
                className="graph-dot ram"
                style={{
                  left: `${x}%`,
                  top: `${100 - Math.max(0, Math.min(100, item.ram || 0))}%`,
                }}
              />
              <div
                className={`graph-tooltip ${x > 75 ? "left" : ""}`}
                style={{ left: `${x}%` }}
              >
                <b>
                  {new Date(item.at).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </b>
                <span>
                  <i className="cpu" />
                  CPU <strong>{Number(item.cpu || 0).toFixed(1)}%</strong>
                </span>
                <span>
                  <i className="ram" />
                  RAM <strong>{Number(item.ram || 0).toFixed(1)}%</strong>
                </span>
              </div>
            </>
          )}
        </>
      ) : (
        <div className="graph-empty">
          <Activity />
          <span>{emptyText}</span>
        </div>
      )}
    </div>
  );
}

function PlayerGraph({ data = [] }) {
  const [hover, setHover] = useState(null);
  const rows = data.slice(-120), width = 1000, height = 180;
  const points = rows.map((row, index) => `${rows.length === 1 ? width / 2 : (index / (rows.length - 1)) * width},${height - Math.max(0, Math.min(100, row.percent || 0)) / 100 * height}`).join(" ");
  const move = (event) => {
    if (!rows.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHover(Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (rows.length - 1)));
  };
  const item = hover === null ? null : rows[hover], x = rows.length < 2 ? 50 : (hover / (rows.length - 1)) * 100;
  return <div className="live-graph player-graph" onMouseMove={move} onMouseLeave={() => setHover(null)}>
    {rows.length ? <>
      <div className="graph-lines"><i /><i /><i /><i /><i /></div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Minecraft player count history">
        <defs><linearGradient id="playerFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#38a780" stopOpacity=".28" /><stop offset="1" stopColor="#38a780" stopOpacity="0" /></linearGradient></defs>
        <polygon className="player-area" points={`0,${height} ${points} ${width},${height}`} />
        <polyline className="player-line" points={points} />
      </svg>
      {item && <><span className="graph-cursor" style={{ left: `${x}%` }} /><span className="graph-dot player" style={{ left: `${x}%`, top: `${100 - item.percent}%` }} /><div className={`graph-tooltip ${x > 75 ? "left" : ""}`} style={{ left: `${x}%` }}><b>{new Date(item.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</b><span><i className="player" />Players <strong>{item.players} / {item.maxPlayers}</strong></span></div></>}
    </> : <div className="graph-empty"><Users /><span>Waiting for Minecraft player data…</span></div>}
  </div>;
}

function MiniGraph({ data = [], metric, autoScale = false }) {
  const raw = data
    .slice(-24)
    .map((row) => Number(row[metric]))
    .filter(Number.isFinite);
  if (!raw.length) return <span className="mini-graph-empty">LIVE</span>;
  const values = raw.length === 1 ? [raw[0], raw[0]] : raw;
  const ceiling = autoScale ? Math.max(0.01, ...values) * 1.15 : 100;
  const points = values
    .map(
      (value, index) =>
        `${(index / (values.length - 1)) * 122},${38 - (Math.max(0, Math.min(ceiling, value)) / ceiling) * 34}`,
    )
    .join(" ");
  return (
    <svg
      viewBox="0 0 122 40"
      preserveAspectRatio="none"
      aria-label={`${metric} history`}
    >
      <polyline points={points} />
      <polygon points={`0,40 ${points} 122,40`} />
    </svg>
  );
}

function StorageUpgrade({ vm, close, refresh }) {
  const cpuChoices = [.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].filter((size) => size >= vm.cpu);
  const ramChoices = [.5, 1, 2, 4, 6, 8, 10, 12].filter((size) => size >= vm.ram);
  const diskChoices = [...new Set([vm.disk, 100, 200, 300, 400, 500])].filter((size) => size >= vm.disk).sort((a, b) => a - b);
  const [cpu, setCpu] = useState(vm.cpu),
    [ram, setRam] = useState(vm.ram),
    [disk, setDisk] = useState(vm.disk),
    [payment, setPayment] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const changed = cpu > vm.cpu || ram > vm.ram || disk > vm.disk;
  const monthlyUpgrade = Math.max(0, (cpu - vm.cpu) * 1 + (ram - vm.ram) * 1.5 + ((disk - vm.disk) / 100) * 3);
  const upgrade = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api(`/v1/vms/${vm.name}/upgrade`, {
        method: "POST",
        body: JSON.stringify({ cpu, ram, disk }),
      });
      if (!result.payment?.clientSecret || !result.payment?.publishableKey) throw new Error("Stripe embedded checkout could not be started.");
      setPayment(result.payment);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const confirmStripe = async () => {
    await api("/v1/payments/stripe/confirm", { method: "POST", body: JSON.stringify({ orderId: payment.orderId, sessionId: payment.sessionId }) });
    await refresh(); close();
  };
  if (payment) return <StripeCheckoutModal payment={payment} title={`Upgrade ${vm.name}`} onComplete={confirmStripe} onClose={() => setPayment(null)} />;
  return (
    <div className="vh-modal-bg">
      <div className="storage-upgrade-modal">
        <header>
          <div>
            <small>INSTANCE UPGRADE</small>
            <h2>Upgrade resources</h2>
          </div>
          <button onClick={close}>
            <X />
          </button>
        </header>
        <p>
          Increase CPU, memory or storage for <strong>{vm.name}</strong>. A
          running node restarts once when CPU or RAM changes. Monthly upgrade
          rates: €1.00/vCPU, €1.50/GB RAM and €3.00/100 GB storage.
        </p>
        <div className="resource-upgrade-groups">
          <section>
            <header><Cpu /><span><strong>CPU</strong><small>Compute allocation</small></span><b>{cpu} vCPU</b></header>
            <div className="resource-choice-row">{cpuChoices.map((size) => <button key={size} className={cpu === size ? "selected" : ""} onClick={() => setCpu(size)}>{size}</button>)}</div>
          </section>
          <section>
            <header><Database /><span><strong>Memory</strong><small>Guest RAM</small></span><b>{ram} GB</b></header>
            <div className="resource-choice-row">{ramChoices.map((size) => <button key={size} className={ram === size ? "selected" : ""} onClick={() => setRam(size)}>{size}</button>)}</div>
          </section>
          <section>
            <header><HardDrive /><span><strong>Storage</strong><small>NVMe virtual disk</small></span><b>{disk} GB</b></header>
            <div className="resource-choice-row">{diskChoices.map((size) => <button key={size} className={disk === size ? "selected" : ""} onClick={() => setDisk(size)}>{size}</button>)}</div>
          </section>
        </div>
        {!changed && cpu === 4 && ram === 12 && disk === 500 && (
          <div className="upgrade-maximum">
            <Check /> This node already has the maximum available resources.
          </div>
        )}
        <div className="upgrade-summary">
          <span>
            CPU <b>{vm.cpu} → {cpu} vCPU</b>
          </span>
          <span>
            Memory <b>{vm.ram} → {ram} GB</b>
          </span>
          <span>
            Storage <b>{vm.disk} → {disk} GB</b>
          </span>
          <span>
            Monthly upgrade <b>€{monthlyUpgrade.toFixed(2)}</b>
          </span>
        </div>
        {error && <div className="vh-error">{error}</div>}
        <footer>
          <button className="secondary" onClick={close}>
            Cancel
          </button>
          <button disabled={busy || !changed} onClick={upgrade}>
            {busy ? "Preparing Stripe…" : `Pay securely · €${monthlyUpgrade.toFixed(2)}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Auth({ mode, onAuth }) {
  const register = mode === "register";
  const [form, setForm] = useState({ name: "", email: "", password: "", twoFactorCode: "", referralCode: register ? new URLSearchParams(location.search).get("ref") || "" : "", acceptTerms: false, acceptPrivacy: false }),
    [error, setError] = useState(""),
    [pendingMessage, setPendingMessage] = useState(""),
    [twoFactorRequired, setTwoFactorRequired] = useState(false),
    [busy, setBusy] = useState(false),
    [passkeyBusy, setPasskeyBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const body = await api(`/v1/auth/${register ? "register" : "login"}`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      if (body.pendingApproval) {
        setPendingMessage(body.message || "Your account is waiting for administrator approval.");
        return;
      }
      onAuth(body.user);
      if (["/login", "/register"].includes(location.pathname))
        history.replaceState({}, "", "/app");
    } catch (err) {
      if (err.body?.code === "TWO_FACTOR_REQUIRED") setTwoFactorRequired(true);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const signInWithPasskey = async () => {
    setError("");
    if (!form.email.trim()) return setError("Enter your email address first.");
    if (!browserSupportsWebAuthn()) return setError("This browser does not support passkeys.");
    setPasskeyBusy(true);
    try {
      const begin = await api("/v1/auth/passkeys/options", { method: "POST", body: JSON.stringify({ email: form.email }) });
      const response = await startAuthentication({ optionsJSON: begin.options });
      const result = await api("/v1/auth/passkeys/verify", { method: "POST", body: JSON.stringify({ challengeId: begin.challengeId, response }) });
      onAuth(result.user);
      if (["/login", "/register"].includes(location.pathname)) history.replaceState({}, "", "/app");
    } catch (err) {
      setError(err.name === "NotAllowedError" ? "Passkey sign-in was cancelled or timed out." : err.message);
    } finally { setPasskeyBusy(false); }
  };
  return (
    <div className="vh-auth">
      <a className="vh-back" href="/">
        ← Back to website
      </a>
      <form onSubmit={submit}>
        <Brand />
        <small>{register ? "CREATE ACCOUNT" : "WELCOME BACK"}</small>
        <h1>{register ? "Start with Vyron" : "Sign in to Vyron"}</h1>
        <p>
          {register
            ? "Create your account. Access starts after administrator approval."
            : "Manage nodes, orders and billing."}
        </p>
        {pendingMessage && <div className="settings-success"><ShieldCheck /> {pendingMessage}</div>}
        {register && (
          <label>
            Name
            <input
              required
              minLength="2"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoComplete="name"
            />
          </label>
        )}
        <label>
          Email
          <input
            required
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            autoComplete={register ? "email" : "username webauthn"}
          />
        </label>
        <label>
          Password
          <input
            required
            type="password"
            minLength="8"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            autoComplete={register ? "new-password" : "current-password"}
          />
        </label>
        {!register && twoFactorRequired && <label>Authentication code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9A-Za-z -]{6,20}" value={form.twoFactorCode} onChange={(e) => setForm({ ...form, twoFactorCode: e.target.value })} placeholder="6-digit code or recovery code" autoFocus /></label>}
        {register && form.referralCode && <div className="settings-success"><Users /> Referral code {form.referralCode} applied</div>}
        {register && <div className="legal-consent"><label><input required type="checkbox" checked={form.acceptTerms} onChange={(e) => setForm({ ...form, acceptTerms: e.target.checked })} /><span>I accept the <a href="/terms" target="_blank">Terms and Conditions</a>.</span></label><label><input required type="checkbox" checked={form.acceptPrivacy} onChange={(e) => setForm({ ...form, acceptPrivacy: e.target.checked })} /><span>I acknowledge the <a href="/privacy" target="_blank">Privacy Policy</a>.</span></label></div>}
        {error && <div className="vh-error">{error}</div>}
        <button disabled={busy || Boolean(pendingMessage)}>
          {busy ? "Please wait…" : pendingMessage ? "Awaiting approval" : register ? "Create free account" : "Sign in"}
        </button>
        {!register && <><div className="auth-divider"><span>or</span></div><button className="passkey-login" type="button" disabled={busy || passkeyBusy} onClick={signInWithPasskey}><KeyRound /> {passkeyBusy ? "Waiting for passkey…" : "Sign in with passkey"}</button></>}
        <footer>
          {register ? "Already registered?" : "No account yet?"}{" "}
          <a href={register ? "/login" : "/register"}>
            {register ? "Sign in" : "Create account"}
          </a>
        </footer>
      </form>
    </div>
  );
}

function WorkspaceSetup({ user, onCreated }) {
  const suggested = `${user.name.split(" ")[0]}-cloud`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 24);
  const [form, setForm] = useState({
      name: `${user.name}'s workspace`,
      slug: suggested.length >= 3 ? suggested : "my-cloud",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/v1/workspaces", {
        method: "POST",
        body: JSON.stringify(form),
      });
      await onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="workspace-setup">
      <div className="workspace-card">
        <Brand />
        <span className="setup-step">ACCOUNT READY · STEP 2 OF 2</span>
        <h1>Create your workspace</h1>
        <p>
          Your workspace keeps nodes, billing, domains and team settings
          together.
        </p>
        <form onSubmit={submit}>
          <label>
            Workspace name
            <input
              required
              minLength="2"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Workspace ID
            <div className="slug-input">
              <input
                required
                minLength="3"
                value={form.slug}
                onChange={(e) =>
                  setForm({
                    ...form,
                    slug: e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9-]/g, ""),
                  })
                }
              />
              <span>.vyron.cloud</span>
            </div>
          </label>
          <div className="setup-region">
            <Globe2 />
            <div>
              <b>EU Central</b>
              <small>Primary compute region · EU Central</small>
            </div>
            <Check />
          </div>
          {error && <div className="vh-error">{error}</div>}
          <button disabled={busy}>
            {busy ? "Creating workspace…" : "Continue to dashboard"}
            <ChevronRight />
          </button>
        </form>
      </div>
    </div>
  );
}

function Deploy({ close, onCreated, account }) {
  const [data, setData] = useState({
      plan: "basic",
      template: "node",
      name: "",
      coupon: "",
      archive: null,
      entryFile: "",
      source: "upload",
      github: { repository: "", branch: "" },
      minecraft: { loader: "paper", version: "1.21.11", maxPlayers: 20, motd: "A Vyron Minecraft Server" },
    }),
    [step, setStep] = useState(1),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [couponOk, setCouponOk] = useState(null),
    [minecraftStage, setMinecraftStage] = useState(1),
    [createdVm, setCreatedVm] = useState(null),
    [payment, setPayment] = useState(null);
  const selected = plans.find((p) => p.id === data.plan);
  const couponDiscount = couponOk ? +(selected.price * Number(couponOk.percent || 0) / 100).toFixed(2) : 0;
  const dueToday = +(selected.price - couponDiscount).toFixed(2);
  const capacity = account?.host?.capacity || {};
  const planAvailable = (plan) => !capacity.available || ["cpu", "ram", "disk"].every((key) => Number(plan[key] || 0) <= Number(capacity.available[key] ?? 0));
  const selectedAvailable = planAvailable(selected);
  const needsProject = ["node", "nginx"].includes(data.template);
  const normalizedRepository = data.github.repository.trim().replace(/\/+$/, "");
  const projectReady = !needsProject || (Boolean(data.entryFile) &&
    (data.source === "upload" ? Boolean(data.archive) : /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(normalizedRepository)));
  const selectArchive = async (file) => {
    setError("");
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Choose a ZIP archive.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("The ZIP archive must be 20 MB or smaller.");
      return;
    }
    try {
      const zip = await JSZip.loadAsync(file);
      const rawFiles = Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name.replaceAll("\\", "/").replace(/^\/+/, ""));
      if (!rawFiles.length) throw new Error("The ZIP archive is empty.");
      const first = rawFiles[0].split("/")[0];
      const stripRoot = rawFiles.every((name) => name.startsWith(`${first}/`));
      const files = rawFiles.map((name) => stripRoot ? name.slice(first.length + 1) : name).filter(Boolean);
      const candidates = files.filter((name) => data.template === "node" ? /\.(?:js|mjs|cjs)$/i.test(name) : /\.html?$/i.test(name));
      const preferred = data.template === "node"
        ? ["server.js", "app.js", "index.js", "src/server.js", "src/index.js"].find((name) => candidates.includes(name))
        : ["index.html", "public/index.html", "dist/index.html"].find((name) => candidates.includes(name));
      if (!candidates.length) throw new Error(data.template === "node" ? "No JavaScript start file was found in the ZIP." : "No HTML start page was found in the ZIP.");
      const archiveData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("The ZIP archive could not be read."));
        reader.readAsDataURL(file);
      });
      setData((current) => ({ ...current, entryFile: preferred || candidates[0], archive: { name: file.name, data: archiveData, entries: candidates } }));
    } catch (archiveError) {
      setData((current) => ({ ...current, archive: null, entryFile: "" }));
      setError(archiveError.message || "The ZIP archive could not be inspected.");
    }
  };
  const validateCoupon = async () => {
    setError("");
    try {
      const validated = await api("/v1/coupons/validate", {
        method: "POST",
        body: JSON.stringify({ code: data.coupon, plan: data.plan }),
      });
      setCouponOk(validated);
    } catch (e) {
      setCouponOk(null);
      setError(e.message);
    }
  };
  const order = async () => {
    if (!selectedAvailable) {
      setError("This plan is currently unavailable because there is not enough server capacity. Choose another plan or try again later.");
      setStep(1);
      return;
    }
    if (data.name.length < 3) {
      setError("Node names need at least 3 characters. Try mc-server instead of mc.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (data.coupon.trim()) {
        const validated = await api("/v1/coupons/validate", {
          method: "POST",
          body: JSON.stringify({ code: data.coupon, plan: data.plan }),
        });
        setCouponOk(validated);
      }
      const body = await api("/v1/orders", {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (body.payment?.clientSecret && body.payment?.publishableKey) {
        setPayment(body.payment);
        return;
      }
      setCreatedVm(body.vm || null);
      onCreated(body);
      setStep(4);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (step !== 4 || !createdVm?.name) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const account = await api("/v1/account");
        const next = account.vms?.find((vm) => vm.id === createdVm.id || vm.name === createdVm.name);
        if (active && next) setCreatedVm(next);
      } catch {}
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [step, createdVm?.id, createdVm?.name]);
  const createdStatus = createdVm?.status || "provisioning";
  const minecraftStatus = createdVm?.minecraft?.status;
  const creationFailed = createdStatus === "failed" || minecraftStatus === "failed";
  const creationReady = createdStatus === "running" && (!createdVm?.minecraft || ["running", "stopped"].includes(minecraftStatus));
  const creationStageText = String(createdVm?.minecraft?.stage || "Creating virtual machine").toLowerCase();
  const creationStage = creationReady ? 4 : creationStageText.includes("starting") ? 3 : creationStageText.includes("download") ? 2 : creationStageText.includes("java") || creationStageText.includes("resolv") ? 1 : 0;
  const confirmStripe = async () => {
    const body = await api("/v1/payments/stripe/confirm", { method: "POST", body: JSON.stringify({ orderId: payment.orderId, sessionId: payment.sessionId }) });
    setCreatedVm(body.vm || null); await onCreated(body); setPayment(null); setStep(4);
  };
  const cancelStripe = async () => {
    await api("/v1/payments/stripe/cancel", { method: "POST", body: JSON.stringify({ orderId: payment.orderId, sessionId: payment.sessionId }) }).catch(() => {});
    setPayment(null);
  };
  if (payment) return <StripeCheckoutModal payment={payment} title={`Complete ${data.name} order`} onComplete={confirmStripe} onClose={cancelStripe} />;
  return (
    <div className="vh-modal-bg">
      <div className="vh-modal">
        <header>
          <div>
            <small>{step === 2 && data.template === "minecraft" ? `MINECRAFT SETUP · STAGE ${minecraftStage} OF 3` : `NEW NODE · STEP ${Math.min(step, 3)} OF 3`}</small>
            <h2>
              {step === 1
                ? "Choose a plan"
                : step === 2
                  ? data.template === "minecraft" ? ["Choose server software", "Choose Minecraft version", "Configure your server"][minecraftStage - 1] : "Choose software"
                  : step === 3
                    ? "Review order"
                    : "Deployment started"}
            </h2>
          </div>
          <button onClick={close}>
            <X />
          </button>
        </header>
        {step === 1 && (
          <div className="vh-plan-grid">
            {plans.map((p) => (
              <button
                key={p.id}
                className={`${data.plan === p.id ? "selected" : ""} ${!planAvailable(p) ? "unavailable" : ""}`}
                disabled={!planAvailable(p)}
                onClick={() => {
                  setData({ ...data, plan: p.id });
                  setCouponOk(null);
                }}
              >
                {p.popular && <b>POPULAR</b>}
                <strong>{p.name}</strong>
                <em>
                  €{p.price.toFixed(2)}
                  <small>/month</small>
                </em>
                <span>
                  {p.cpu} vCPU · {p.ram} GB RAM
                </span>
                <span>{p.disk} GB NVMe</span>
                {!planAvailable(p) && <small className="plan-unavailable">Currently unavailable</small>}
                {data.plan === p.id && <Check />}
              </button>
            ))}
          </div>
        )}
        {step === 2 && (
          <div className="vh-software-step">
            {(data.template !== "minecraft" || minecraftStage === 1) && <div className="vh-template-grid">
              {templates.map((t) => (
                <button
                  key={t.id}
                  className={data.template === t.id ? "selected" : ""}
                  onClick={() =>
                    setData({
                      ...data,
                      template: t.id,
                      archive: t.id === data.template ? data.archive : null,
                      entryFile: t.id === data.template ? data.entryFile : "",
                    })
                  }
                >
                  <Package />
                  <strong>{t.name}</strong>
                  {data.template === t.id && <Check />}
                </button>
              ))}
            </div>}
            {needsProject && (
              <div className="project-source">
                <div className="project-source-tabs">
                  <button type="button" className={data.source === "upload" ? "active" : ""} onClick={() => { setError(""); setData({ ...data, source: "upload", entryFile: "", github: { repository: "", branch: "" } }); }}><UploadCloud /> Upload ZIP</button>
                  <button type="button" className={data.source === "github" ? "active" : ""} onClick={() => { setError(""); setData({ ...data, source: "github", archive: null, entryFile: "" }); }}><GitBranch /> GitHub repository</button>
                </div>
                {data.source === "upload" ? <label className={data.archive ? "vh-upload ready" : "vh-upload"}>
                <input
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(event) => selectArchive(event.target.files?.[0])}
                />
                {data.archive ? <FileArchive /> : <UploadCloud />}
                <span>
                  <strong>
                    {data.archive
                      ? data.archive.name
                      : "Upload your project ZIP"}
                  </strong>
                  <small>
                    {data.template === "node"
                      ? "Requires package.json with a start script · up to 20 MB"
                      : "Static HTML, CSS and JavaScript · up to 20 MB"}
                  </small>
                </span>
                <b>{data.archive ? "Ready" : "Choose file"}</b>
                </label> : <div className="github-source-form">
                  <GitBranch />
                  <div>
                    <label>Public repository URL<input value={data.github.repository} onChange={e => { setError(""); setData({ ...data, github: { ...data.github, repository: e.target.value } }); }} onBlur={() => setData(current => ({ ...current, github: { ...current.github, repository: current.github.repository.trim().replace(/\/+$/, "") } }))} placeholder="https://github.com/owner/repository" /></label>
                    <label>Branch <input value={data.github.branch} onChange={e => setData({ ...data, github: { ...data.github, branch: e.target.value } })} placeholder="Default branch" /></label>
                  </div>
                  <small className={data.github.repository && !projectReady ? "invalid" : ""}>{data.github.repository && !projectReady ? "Enter a public GitHub URL, for example https://github.com/owner/repository" : "Vyron clones the repository and lets you pull & redeploy later."}</small>
                </div>}
                {data.source === "upload" && data.archive && <label className="project-entry-file">{data.template === "node" ? "Start file" : "Main page"}<select value={data.entryFile} onChange={(event) => setData({ ...data, entryFile: event.target.value })}>{data.archive.entries.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select><small>{data.template === "node" ? "Vyron installs package.json dependencies, then starts this file with Node.js." : "Nginx serves this file as the website entry page."}</small></label>}
                {data.source === "github" && <label className="project-entry-file">{data.template === "node" ? "Start file in repository" : "Main page in repository"}<input value={data.entryFile} onChange={(event) => setData({ ...data, entryFile: event.target.value.replaceAll("\\", "/").replace(/^\/+/, "") })} placeholder={data.template === "node" ? "server.js" : "index.html"} /><small>Path relative to the repository root.</small></label>}
              </div>
            )}
            {data.template === "minecraft" && minecraftStage === 1 && (
              <section className="minecraft-config">
                <div className="minecraft-config-head">
                  <span className="minecraft-cube"><Gamepad2 /></span>
                  <div><small>SERVER SOFTWARE</small><h3>Choose how Minecraft should run</h3><p>The loader is installed through the Vyron Server API.</p></div>
                </div>
                <div className="minecraft-loader-grid">
                  {minecraftLoaders.map(loader => (
                    <button type="button" key={loader.id} className={data.minecraft.loader === loader.id ? "selected" : ""} onClick={() => setData({ ...data, minecraft: { ...data.minecraft, loader: loader.id } })}>
                      <span><Gamepad2 /></span><div><strong>{loader.name}</strong><small>{loader.note}</small></div><em>{loader.tag}</em>{data.minecraft.loader === loader.id && <Check />}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {data.template === "minecraft" && minecraftStage === 2 && (
              <section className="minecraft-config minecraft-version-step">
                <div className="minecraft-config-head"><span className="minecraft-cube"><Package /></span><div><small>{data.minecraft.loader.toUpperCase()}</small><h3>Select a Minecraft version</h3><p>The matching server build is resolved automatically.</p></div></div>
                <div className="minecraft-version-grid">{["1.21.11", "1.21.10", "1.21.8", "1.21.4", "1.20.6", "1.20.4", "1.20.1"].map((version, index) => <button type="button" key={version} className={data.minecraft.version === version ? "selected" : ""} onClick={() => setData({ ...data, minecraft: { ...data.minecraft, version } })}><span>{version}</span>{index === 0 && <em>LATEST</em>}{data.minecraft.version === version && <Check />}</button>)}</div>
              </section>
            )}
            {data.template === "minecraft" && minecraftStage === 3 && (
              <section className="minecraft-config">
                <div className="minecraft-config-head"><span className="minecraft-cube"><Settings /></span><div><small>SERVER OPTIONS</small><h3>Configure the experience</h3><p>These settings remain editable from the node dashboard.</p></div></div>
                <div className="minecraft-options">
                  <label>Server software<input value={data.minecraft.loader[0].toUpperCase() + data.minecraft.loader.slice(1)} disabled /><small>Selected in stage one</small></label>
                  <label>Minecraft version<input value={data.minecraft.version} disabled /><small>Java is selected automatically</small></label>
                  <label>Player slots<input type="number" min="1" max="200" value={data.minecraft.maxPlayers} onChange={e => setData({ ...data, minecraft: { ...data.minecraft, maxPlayers: Math.max(1, Math.min(200, Number(e.target.value))) } })} /><small>Between 1 and 200 players</small></label>
                  <label className="minecraft-motd">Server message<input maxLength="80" value={data.minecraft.motd} onChange={e => setData({ ...data, minecraft: { ...data.minecraft, motd: e.target.value } })} /><small>Shown in the Minecraft multiplayer list</small></label>
                </div>
              </section>
            )}
          </div>
        )}
        {step === 3 && (
          <div className="vh-checkout">
            <label>
              Node name
              <div>
                <input
                  placeholder="my-node"
                  value={data.name}
                  onChange={(e) =>
                    setData({
                      ...data,
                      name: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, ""),
                    })
                  }
                />
                <span>.vyronhosting.com</span>
              </div>
              {data.name.length > 0 && data.name.length < 3 && <small className="field-hint error">Use at least 3 characters, for example mc-server.</small>}
            </label>
            {data.archive && (
              <p className="vh-project-file">
                <FileArchive /> Project ZIP <b>{data.archive.name}</b>
              </p>
            )}
            {needsProject && data.source === "github" && (
              <p className="vh-project-file"><GitBranch /> GitHub <b>{data.github.repository}</b></p>
            )}
            {needsProject && <p className="vh-project-file"><FileCode2 /> {data.template === "node" ? "Start file" : "Main page"} <b>{data.entryFile}</b></p>}
            {data.template === "minecraft" && <p className="vh-project-file"><Gamepad2 /> Minecraft <b>{data.minecraft.loader[0].toUpperCase() + data.minecraft.loader.slice(1)} {data.minecraft.version} · {data.minecraft.maxPlayers} slots</b></p>}
            <label>
              Coupon
              <div>
                <input
                  value={data.coupon}
                  onChange={(e) => {
                    setData({ ...data, coupon: e.target.value.toUpperCase() });
                    setCouponOk(null);
                  }}
                />
                <button type="button" onClick={validateCoupon}>Apply</button>
              </div>
            </label>
            {couponOk && (
              <p className="vh-success">
                <Check /> {couponOk.code} applied – {couponOk.percent}% off {couponOk.firstMonthOnly ? "your first month" : "this order"}
              </p>
            )}
            <section>
              <div>
                <span>{selected.name}</span>
                <b>€{selected.price.toFixed(2)}</b>
              </div>
              <div>
                <span>Discount</span>
                <b>{couponOk ? `−€${couponDiscount.toFixed(2)}` : "€0.00"}</b>
              </div>
              <div>
                <strong>Due today</strong>
                <strong>
                  €{dueToday.toFixed(2)}
                </strong>
              </div>
            </section>
            {!selectedAvailable && <p className="vh-error">This plan is no longer available. Choose a different plan before continuing.</p>}
            <p className="vh-note">
              <ShieldCheck /> Payment stays inside Vyron using secure Stripe Embedded Checkout. Your node is created only after confirmation.
            </p>
          </div>
        )}
        {step === 4 && (
          <div className={`vh-launched ${data.template === "minecraft" ? "minecraft-launch" : ""}`}>
            <span className="launch-orbit">{data.template === "minecraft" ? <Gamepad2 /> : <Server />}<i /><i /></span>
            <h3>{creationFailed ? `${data.name} could not be created` : creationReady ? `${data.name} is ready` : `${data.name} is being created`}</h3>
            <p>
              {creationFailed ? (createdVm?.error || createdVm?.minecraft?.error || "The deployment failed. Open the node for details.") : creationReady ? "Your node is online and ready to use." : data.template === "minecraft" ? `We are creating the VM, installing Java and preparing ${data.minecraft.loader[0].toUpperCase() + data.minecraft.loader.slice(1)} ${data.minecraft.version}. The node stays locked until it is ready.` : "Vyron is allocating the resources for your new server. This normally takes a few minutes."}
            </p>
            {data.template === "minecraft" && <div className="creation-steps">{["Creating virtual machine", "Installing Java", `Downloading ${data.minecraft.loader}`, "Starting server"].map((label, index) => <span className={index < creationStage ? "done" : index === creationStage && !creationReady ? "active" : ""} key={label}><i />{label}</span>)}</div>}
            <button onClick={close}>View my nodes</button>
          </div>
        )}
        {error && <div className="vh-error">{error}</div>}
        {step < 4 && (
          <footer>
            <button
              className="secondary"
              onClick={() => step === 2 && data.template === "minecraft" && minecraftStage > 1 ? setMinecraftStage(minecraftStage - 1) : (step === 1 ? close() : setStep(step - 1))}
            >
              Back
            </button>
            <button
              disabled={
                busy ||
                (step === 2 && !projectReady) ||
                (step === 3 && !selectedAvailable)
              }
              onClick={() => step === 2 && data.template === "minecraft" && minecraftStage < 3 ? setMinecraftStage(minecraftStage + 1) : (step < 3 ? setStep(step + 1) : order())}
            >
              {busy
                ? "Creating…"
                : step === 3
                  ? "Continue to secure payment"
                  : "Continue"}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function Overview({ account, openDeploy, setPage, openVm, canCreate = true }) {
  const active = account.vms.filter(
    (v) => !["deleted", "failed"].includes(v.status),
  );
  const metrics = account.host?.metrics || {},
    cpu = metrics.cpu || 0,
    usedRam = metrics.usedRam || 0,
    totalRam = metrics.totalRam || 15.5;
  const monthly = account.orders
    .filter((o) => o.status === "paid")
    .reduce((sum, o) => sum + o.total, 0);
  const cards = [
    {
      label: "CPU USAGE",
      value: `${cpu.toFixed(1)}%`,
      note: "all servers",
      icon: Cpu,
      color: "violet",
      points: "0,31 18,27 35,29 53,18 70,23 88,12 104,17 122,8",
    },
    {
      label: "MEMORY",
      value: `${usedRam.toFixed(1)} GB`,
      note: `of ${totalRam.toFixed(1)} GB`,
      icon: Database,
      color: "green",
      points: "0,26 18,30 35,21 53,22 70,13 88,20 104,8 122,12",
    },
    {
      label: "BANDWIDTH",
      value: `${(metrics.networkGb || 0).toFixed(1)} GB`,
      note: "all servers",
      icon: Network,
      color: "orange",
      points: "0,33 18,31 35,23 53,27 70,17 88,12 104,15 122,7",
    },
    {
      label: "EST. COST",
      value: `€${monthly.toFixed(2)}`,
      note: "this account",
      icon: Zap,
      color: "blue",
      points: "0,34 18,30 35,27 53,24 70,19 88,14 104,9 122,5",
    },
  ];
  const fallbackActivities = [
    ...active.slice(0, 2).map((v) => ({
      title:
        v.status === "running" ? "Deployment completed" : "Provisioning node",
      copy: `${v.name} · ${v.template}`,
      kind: v.status,
    })),
    ...account.orders
      .slice(-2)
      .reverse()
      .map((o) => ({
        title: o.status === "paid" ? "Order paid" : "Payment required",
        copy: `${o.plan} · €${o.total.toFixed(2)}`,
        kind: o.status,
      })),
  ].slice(0, 3);
  const activities = account.events?.length ? account.events.slice(0, 3).map((event) => ({ title: event.title, copy: event.nodeName ? `${event.nodeName} · ${event.detail}` : event.detail, kind: event.severity, createdAt: event.createdAt })) : fallbackActivities;
  return (
    <div className="ent-overview">
      <div className="ent-welcome">
        <div>
          <small>
            {new Date()
              .toLocaleDateString("en-GB", {
                weekday: "long",
                month: "long",
                day: "numeric",
              })
              .toUpperCase()}
          </small>
          <h1>Good evening, {account.user.name.split(" ")[0]}.</h1>
          <p>Everything is running smoothly across your infrastructure.</p>
        </div>
        {canCreate && <button onClick={openDeploy}>
          <Plus /> New node
        </button>}
      </div>
      <div className="ent-stats">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <article key={c.label} className={c.color}>
              <header>
                <span>
                  <Icon />
                </span>
                <small>{c.label}</small>
                <em>{c.note}</em>
              </header>
              <strong>{c.value}</strong>
              <svg viewBox="0 0 122 40" preserveAspectRatio="none">
                <polyline points={c.points} />
                <path d={`M${c.points.replaceAll(" ", " L")} L122,40 L0,40Z`} />
              </svg>
            </article>
          );
        })}
      </div>
      <div className="ent-grid">
        <section className="ent-panel ent-instances">
          <header>
            <div>
              <h2>Nodes</h2>
              <p>Your active compute resources</p>
            </div>
            <button onClick={() => setPage("nodes")}>
              View all <ChevronRight />
            </button>
          </header>
          {active.length ? (
            <div>
              {active.slice(0, 4).map((v, i) => (
                <article key={v.id} onClick={() => openVm(v.id)}>
                  <span className={`server-icon tone-${i % 3}`}>
                    <Server />
                  </span>
                  <div>
                    <strong>{v.name}</strong>
                    <small>
                      {v.template} · {v.plan}
                    </small>
                  </div>
                  <em className={v.status}>
                    <i />
                    {nodeStatusLabel(v.status, v.minecraft)}
                  </em>
                  <label>
                    <small>CPU</small>
                    <b>{v.metrics?.cpu?.toFixed?.(1) || "0.0"}%</b>
                    <i>
                      <span style={{ width: `${v.metrics?.cpu || 0}%` }} />
                    </i>
                  </label>
                  <label>
                    <small>RAM</small>
                    <b>
                      {v.metrics?.usedRamMb
                        ? `${Math.round(v.metrics.usedRamMb)} MB`
                        : `${v.ram} GB`}
                    </b>
                    <i>
                      <span
                        style={{
                          width: `${Math.min(100, ((v.metrics?.usedRamMb || 0) / (v.ram * 1024)) * 100)}%`,
                        }}
                      />
                    </i>
                  </label>
                  <button>
                    <MoreHorizontal />
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="ent-empty">
              <Server />
              <span>
                <b>No nodes yet</b>
                <small>Use FREE26 for 20% off your first month.</small>
              </span>
              {canCreate && <button onClick={openDeploy}>Create node</button>}
            </div>
          )}
        </section>
        <section className="ent-panel ent-activity">
          <header>
            <div>
              <h2>Server activity</h2>
              <p>Recent server activity</p>
            </div>
            <span>
              <i /> LIVE
            </span>
          </header>
          <div>
            {activities.length ? (
              activities.map((a, i) => (
                <article key={i}>
                  <span>{i === 0 ? <Check /> : <Activity />}</span>
                  <div>
                    <strong>{a.title}</strong>
                    <p>{a.copy}</p>
                    <small>{a.createdAt ? new Date(a.createdAt).toLocaleString("en-GB") : i === 0 ? "just now" : "recently"}</small>
                  </div>
                </article>
              ))
            ) : (
              <div className="ent-empty small">
                <Activity />
                <span>
                  <b>No activity yet</b>
                  <small>New server events will appear here.</small>
                </span>
              </div>
            )}
          </div>
          <button onClick={() => setPage("helper")}>
            Open AI helper <ChevronRight />
          </button>
        </section>
      </div>
      <section className="ent-panel ent-usage">
        <header>
          <div>
            <h2>Resource usage</h2>
            <p>Live server samples · hover for exact values</p>
          </div>
          <select>
            <option>Live history</option>
          </select>
        </header>
        <div className="ent-chart">
          <div className="y-axis">
            <span>100%</span>
            <span>75%</span>
            <span>50%</span>
            <span>25%</span>
            <span>0%</span>
          </div>
          <div className="plot">
            <LiveGraph
              data={(account.host?.history || []).map((x) => ({
                ...x,
                ram: totalRam ? (x.ram / totalRam) * 100 : 0,
              }))}
            />
            <div className="x-axis">
              <span>Older</span>
              <span>Live samples</span>
              <span>Now</span>
            </div>
          </div>
        </div>
        <footer>
          <span>
            <i className="cpu" />
            CPU <b>{cpu.toFixed(1)}%</b>
          </span>
          <span>
            <i className="ram" />
            Memory <b>{Math.round((usedRam / totalRam) * 100)}%</b>
          </span>
        </footer>
      </section>
    </div>
  );
}

function NodeFiles({ vm }) {
  const projectFiles = ["node", "nginx"].includes(vm.template);
  const minecraftFiles = vm.template === "minecraft";
  const [directory, setDirectory] = useState("."),
    [files, setFiles] = useState([]),
    [selected, setSelected] = useState(""),
    [content, setContent] = useState(""),
    [savedContent, setSavedContent] = useState(""),
    [newName, setNewName] = useState(""),
    [busy, setBusy] = useState(""),
    [dragActive, setDragActive] = useState(false),
    [uploadProgress, setUploadProgress] = useState(null),
    [uploadQueue, setUploadQueue] = useState([]),
    [error, setError] = useState("");
  const dragDepth = useRef(0);
  const loadDirectory = async (next = directory) => {
    setBusy("list"); setError("");
    try { const result = await api(`/v1/vms/${vm.name}/files?path=${encodeURIComponent(next)}`); setFiles(result.files); setDirectory(next); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  useEffect(() => { loadDirectory("."); }, [vm.name]);
  const openFile = async (path) => {
    setBusy("file"); setError("");
    try { const result = await api(`/v1/vms/${vm.name}/file?path=${encodeURIComponent(path)}`); setSelected(result.path); setContent(result.content); setSavedContent(result.content); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  const saveFile = async () => {
    setBusy("save"); setError("");
    try { await api(`/v1/vms/${vm.name}/file`, { method: "PUT", body: JSON.stringify({ path: selected, content }) }); setSavedContent(content); await loadDirectory(directory); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  const createFile = async (e) => {
    e.preventDefault();
    const name = newName.trim().replaceAll("\\", "/");
    if (!name || name.includes("/") || name === "..") return;
    const path = directory === "." ? name : `${directory}/${name}`;
    setBusy("create"); setError("");
    try { await api(`/v1/vms/${vm.name}/file`, { method: "PUT", body: JSON.stringify({ path, content: "" }) }); setNewName(""); await loadDirectory(directory); await openFile(path); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  const cleanRelativePath = (value) => String(value || "").replaceAll("\\", "/").replace(/^\/+/, "").split("/").filter(part => part && part !== "." && part !== "..").join("/");
  const destinationPath = (relative) => directory === "." ? relative : `${directory}/${relative}`;
  const fileData = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
  const uploadFileInChunks = async (file, path, onProgress) => {
    const uploadId = crypto.randomUUID();
    const chunkSize = 8 * 1024 * 1024;
    await api(`/v1/vms/${vm.name}/files/upload/start`, { method: "POST", body: JSON.stringify({ uploadId, path, size: file.size }) });
    try {
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        const end = Math.min(file.size, offset + chunkSize);
        const data = await fileData(file.slice(offset, end));
        await api(`/v1/vms/${vm.name}/files/upload/chunk`, { method: "POST", body: JSON.stringify({ uploadId, offset, data }) });
        onProgress(end);
      }
      await api(`/v1/vms/${vm.name}/files/upload/complete`, { method: "POST", body: JSON.stringify({ uploadId }) });
    } catch (error) {
      await api(`/v1/vms/${vm.name}/files/upload/${uploadId}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
  };
  const uploadItems = async (items, folders = []) => {
    const validItems = items.map(item => ({ file: item.file, path: cleanRelativePath(item.path || item.file?.webkitRelativePath || item.file?.name) })).filter(item => item.file && item.path);
    const validFolders = [...new Set(folders.map(cleanRelativePath).filter(Boolean))].sort((a, b) => a.split("/").length - b.split("/").length);
    if (!validItems.length && !validFolders.length) return;
    const oversized = validItems.find(item => item.file.size > 1024 ** 3);
    if (oversized) return setError(`${oversized.path} is larger than 1 GB.`);
    if (validItems.length > 500) return setError("A folder upload is limited to 500 files at once.");
    const totalBytes = validItems.reduce((sum, item) => sum + item.file.size, 0);
    const queuedItems = validItems.map(item => ({ ...item, id: crypto.randomUUID(), status: "queued", uploaded: 0, error: "" }));
    const updateQueuedItem = (id, patch) => setUploadQueue(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    setUploadQueue(queuedItems.map(({ file, ...item }) => ({ ...item, name: file.name, size: file.size })));
    setBusy("upload"); setError(""); setUploadProgress({ current: 0, total: totalBytes, files: validItems.length });
    try {
      for (const folder of validFolders) {
        await api(`/v1/vms/${vm.name}/files/folder`, { method: "POST", body: JSON.stringify({ path: destinationPath(folder) }) });
      }
      let completedBytes = 0, failures = 0;
      for (const item of queuedItems) {
        updateQueuedItem(item.id, { status: "uploading" });
        try {
          await uploadFileInChunks(item.file, destinationPath(item.path), uploaded => {
            updateQueuedItem(item.id, { uploaded });
            setUploadProgress({ current: completedBytes + uploaded, total: totalBytes, files: validItems.length });
          });
          updateQueuedItem(item.id, { status: "done", uploaded: item.file.size });
        } catch (uploadError) {
          failures += 1;
          updateQueuedItem(item.id, { status: "failed", error: uploadError.message });
        }
        completedBytes += item.file.size;
        setUploadProgress({ current: completedBytes, total: totalBytes, files: validItems.length });
      }
      await loadDirectory(directory);
      if (failures) setError(`${failures} of ${queuedItems.length} files could not be uploaded. See the queue for details.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(""); setUploadProgress(null); }
  };
  const uploadFile = file => file && uploadItems([{ file, path: file.name }]);
  const createFolder = async () => {
    const entered = await sitePrompt({ title: "Create folder", message: `Create a new folder inside /${directory === "." ? "" : directory}.`, placeholder: "folder-name", confirmLabel: "Create folder" });
    const name = cleanRelativePath(entered);
    if (!name || name.includes("/")) return entered && setError("Enter a folder name without slashes.");
    setBusy("folder"); setError("");
    try { await api(`/v1/vms/${vm.name}/files/folder`, { method: "POST", body: JSON.stringify({ path: destinationPath(name) }) }); await loadDirectory(directory); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  const readEntry = entry => new Promise((resolve, reject) => entry.file(resolve, reject));
  const readDirectoryEntries = async reader => {
    const entries = [];
    while (true) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) return entries;
      entries.push(...batch);
    }
  };
  const walkEntry = async (entry, prefix, items, folders) => {
    const path = cleanRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (entry.isFile) items.push({ file: await readEntry(entry), path });
    if (entry.isDirectory) {
      folders.push(path);
      for (const child of await readDirectoryEntries(entry.createReader())) await walkEntry(child, path, items, folders);
    }
  };
  const handleDrop = async event => {
    event.preventDefault(); dragDepth.current = 0; setDragActive(false);
    if (busy) return;
    const items = [], folders = [];
    try {
      const entries = [...(event.dataTransfer.items || [])].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
      if (entries.length) for (const entry of entries) await walkEntry(entry, "", items, folders);
      else for (const file of [...event.dataTransfer.files]) items.push({ file, path: file.webkitRelativePath || file.name });
      await uploadItems(items, folders);
    } catch (e) { setError(e.message || "The dropped folder could not be read."); }
  };
  const parent = directory === "." ? null : directory.split("/").slice(0, -1).join("/") || ".";
  const extension = selected.split(".").at(-1)?.toLowerCase();
  const editorConfig = ({
    js: { label: "javascript", extension: javascript() },
    jsx: { label: "javascript", extension: javascript({ jsx: true }) },
    mjs: { label: "javascript", extension: javascript() },
    cjs: { label: "javascript", extension: javascript() },
    json: { label: "json", extension: json() },
    html: { label: "html", extension: html() },
    htm: { label: "html", extension: html() },
    css: { label: "css", extension: css() },
    yml: { label: "yaml", extension: yaml() },
    yaml: { label: "yaml", extension: yaml() },
    md: { label: "markdown", extension: markdown() },
  })[extension] || { label: extension || "text", extension: null };
  const editorExtensions = editorConfig.extension ? [editorConfig.extension] : [];
  return <section className={`node-files ${dragActive ? "drag-active" : ""}`} onDragEnter={event => { event.preventDefault(); dragDepth.current += 1; setDragActive(true); }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={event => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragActive(false); }} onDrop={handleDrop}>
    <header><div><h2><FileCode2 /> {minecraftFiles ? "Minecraft files" : projectFiles ? "Project files" : "Node files"}</h2><p>{minecraftFiles ? "Manage worlds, mods and configuration inside `/srv/minecraft`" : projectFiles ? "Edit project files and installed dependencies inside `/srv/vyron/app`" : "Upload and edit files safely inside `/home/vyron/files`"}</p></div><span className="node-file-actions"><button onClick={createFolder} disabled={busy}><FolderPlus /> New folder</button><label className={busy === "upload" ? "uploading" : ""}><Folder /> Upload folder<input type="file" webkitdirectory="" multiple disabled={Boolean(busy)} onChange={e => { uploadItems([...e.target.files].map(file => ({ file, path: file.webkitRelativePath || file.name }))); e.target.value = ""; }} /></label><label className={busy === "upload" ? "uploading" : ""}><UploadCloud /> {busy === "upload" ? uploadProgress ? `${Math.round(uploadProgress.current / Math.max(1, uploadProgress.total) * 100)}%` : "Uploading…" : "Upload files"}<input type="file" multiple disabled={Boolean(busy)} onChange={e => { uploadItems([...e.target.files].map(file => ({ file, path: file.name }))); e.target.value = ""; }} /></label><button onClick={() => loadDirectory()} disabled={busy}><RefreshCw /> Refresh</button></span></header>
    {error && <div className="vh-error">{error}</div>}
    {dragActive && <div className="file-drop-overlay"><UploadCloud /><strong>Drop files or folders here</strong><span>They will be uploaded into /{directory === "." ? "" : directory}</span></div>}
    {uploadQueue.length > 0 && <section className="file-upload-queue"><header><div><strong>Upload queue</strong><span>{uploadQueue.filter(item => item.status === "done").length} / {uploadQueue.length} completed</span></div>{busy === "upload" ? <LoaderCircle className="spin" /> : <button type="button" onClick={() => setUploadQueue([])}>Clear</button>}</header><div>{uploadQueue.map(item => <article className={item.status} key={item.id}><span>{item.status === "done" ? <Check /> : item.status === "failed" ? <X /> : item.status === "uploading" ? <LoaderCircle className="spin" /> : <UploadCloud />}</span><div><b>{item.path}</b><small>{item.status === "failed" ? item.error : item.status === "done" ? "Uploaded" : item.status === "uploading" ? `${Math.round(item.uploaded / Math.max(1, item.size) * 100)}% · uploading` : "Waiting"}</small></div><em>{item.size < 1024 * 1024 ? `${Math.max(1, Math.round(item.size / 1024))} KB` : `${(item.size / 1024 / 1024).toFixed(1)} MB`}</em></article>)}</div></section>}
    <div className="node-files-layout">
      <aside>
        <div className="file-path"><button onClick={() => loadDirectory(".")}>{minecraftFiles ? "minecraft" : projectFiles ? "app" : "files"}</button><span>/ {directory === "." ? "" : directory}</span></div>
        {parent && <button className="file-row directory" onClick={() => loadDirectory(parent)}><Folder /><span>..</span></button>}
        {files.map(file => <button className={`file-row ${file.type} ${selected === file.path ? "active" : ""}`} key={file.path} onClick={() => file.type === "directory" ? loadDirectory(file.path) : openFile(file.path)}>{file.type === "directory" ? <Folder /> : <FileCode2 />}<span>{file.name}</span>{file.size !== null && <small>{file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`}</small>}</button>)}
        {!files.length && !busy && <p className="files-empty">This folder is empty.</p>}
        <form className="new-file" onSubmit={createFile}><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="new-file.js" /><button disabled={busy || !newName.trim()}><Plus /></button></form>
      </aside>
      <main>
        {selected ? <><header><span><FileCode2 /> {selected}<em>{editorConfig.label}</em></span><button onClick={saveFile} disabled={busy || content === savedContent}><Save /> {busy === "save" ? "Saving…" : content === savedContent ? "Saved" : projectFiles ? "Save & restart" : "Save file"}</button></header><CodeMirror value={content} onChange={setContent} extensions={editorExtensions} theme={oneDark} height="100%" minHeight="430px" basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, highlightActiveLineGutter: true }} className="syntax-editor" /></> : <div className="file-welcome"><UploadCloud /><h3>{files.length ? "Select a file to edit" : "Upload your first file"}</h3><p>{projectFiles ? "Project changes can restart the Node.js service automatically." : "Files are stored securely on this node."}</p></div>}
      </main>
    </div>
  </section>;
}

function LiveKvmTerminal({ vm }) {
  const mount = useRef(null), terminalRef = useRef(null), socketRef = useRef(null);
  const [connection, setConnection] = useState("connecting"), [attempt, setAttempt] = useState(0), [revealPassword, setRevealPassword] = useState(false);
  useEffect(() => {
    if (!mount.current || vm.status !== "running") { setConnection("offline"); return; }
    let disposed = false;
    const terminal = new Terminal({ cursorBlink: true, cursorStyle: "block", convertEol: false, scrollback: 8000, fontFamily: '"DM Mono", "Cascadia Mono", Consolas, monospace', fontSize: 12, lineHeight: 1.22, theme: { background: "#090b0a", foreground: "#d8ddd8", cursor: "#a78bfa", cursorAccent: "#090b0a", selectionBackground: "#7655d855", black: "#151716", brightBlack: "#676d68", red: "#ff7182", brightRed: "#ff93a0", green: "#57d39a", brightGreen: "#7be7b4", yellow: "#d7bd6c", brightYellow: "#efd98e", blue: "#8b79f5", brightBlue: "#aa9bff", magenta: "#c18cf4", brightMagenta: "#d9a8ff", cyan: "#62c9d5", brightCyan: "#8be4ed", white: "#d8ddd8", brightWhite: "#ffffff" } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(mount.current); terminalRef.current = terminal;
    terminal.writeln("\x1b[38;5;141mVyron KVM console\x1b[0m · establishing secure session…");
    const resize = () => { try { fit.fit(); if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })); } catch {} };
    const observer = new ResizeObserver(resize); observer.observe(mount.current); requestAnimationFrame(resize);
    const input = terminal.onData(data => { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "input", data })); });
    (async () => {
      try {
        const { ticket } = await api(`/v1/vms/${vm.name}/terminal-ticket`, { method: "POST", body: "{}" });
        if (disposed) return;
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(`${protocol}//${location.host}/api/v1/vms/${encodeURIComponent(vm.name)}/terminal?ticket=${encodeURIComponent(ticket)}`);
        socketRef.current = socket;
        socket.onopen = () => { setConnection("live"); resize(); terminal.focus(); };
        socket.onmessage = event => { try { const message = JSON.parse(event.data); if (message.type === "output") terminal.write(message.data); else if (message.type === "error") terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`); else if (message.type === "exit") terminal.writeln(`\r\n\x1b[90mConsole closed (${message.exitCode}).\x1b[0m`); } catch {} };
        socket.onerror = () => { setConnection("error"); terminal.writeln("\r\n\x1b[31mConsole connection failed.\x1b[0m"); };
        socket.onclose = () => { if (!disposed) setConnection(value => value === "error" ? value : "closed"); };
      } catch (error) { setConnection("error"); terminal.writeln(`\r\n\x1b[31m${error.message}\x1b[0m`); }
    })();
    return () => { disposed = true; observer.disconnect(); input.dispose(); socketRef.current?.close(); terminal.dispose(); terminalRef.current = null; socketRef.current = null; };
  }, [vm.name, vm.status, attempt]);
  const username = vm.remoteAccess?.username || vm.username || "vyron";
  return <section className="web-terminal kvm-terminal"><header><div><SquareTerminal /><span><b>Live KVM console</b><small>Direct serial console · interactive PTY</small></span></div><em className={connection}><i />{connection}</em><button onClick={() => terminalRef.current?.clear()}>Clear</button><button onClick={() => setAttempt(value => value + 1)}>Reconnect</button></header><div className="kvm-credentials"><label><span>Username</span><code>{username}<CopyButton value={username} label="Copy console username" /></code></label><label><span>Password</span><code><b>{revealPassword ? vm.initialPassword || "Unavailable" : vm.initialPassword ? "••••••••••••••••" : "Unavailable"}</b>{vm.initialPassword && <><button type="button" onClick={() => setRevealPassword(value => !value)} aria-label={revealPassword ? "Hide console password" : "Show console password"}>{revealPassword ? <EyeOff /> : <Eye />}</button><CopyButton value={vm.initialPassword} label="Copy console password" /></>}</code></label><em className={vm.initialPassword ? "enabled" : "unavailable"}><Check />{vm.initialPassword ? "Automatic login enabled" : "Automatic login unavailable"}</em></div>{vm.status === "running" ? <div className="xterm-host" ref={mount} onClick={() => terminalRef.current?.focus()} /> : <div className="kvm-offline"><Power /><b>Node is offline</b><span>Start the node to open its KVM console.</span></div>}<footer><span>Full keyboard input enabled · Ctrl+C, prompts and interactive programs work normally</span><kbd>Ctrl + ]</kbd><span>disconnects the underlying serial session</span></footer></section>;
}

function NodeWebsites({ vm, refresh }) {
  const makeSlots = () => Array.from({ length: 5 }, (_, index) => {
    const slot = index + 1;
    const stored = vm.websites?.find(item => Number(item.slot) === slot);
    return stored ? { slot, enabled: true, entryFile: stored.entryFile || "" } : { slot, enabled: slot === 1 && Boolean(vm.deployment?.entryFile), entryFile: slot === 1 ? vm.deployment?.entryFile || "" : "" };
  });
  const [websites, setWebsites] = useState(makeSlots), [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  useEffect(() => { setWebsites(makeSlots()); setSaved(false); setError(""); }, [vm.id, vm.websitesUpdatedAt]);
  const hostname = vm.customDomains?.find(item => item.status === "active")?.domain || vm.domain;
  const update = (slot, patch) => setWebsites(current => current.map(item => item.slot === slot ? { ...item, ...patch } : item));
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(""); setSaved(false);
    try {
      await api(`/v1/vms/${vm.name}/websites`, { method: "PUT", body: JSON.stringify({ websites }) });
      setSaved(true); await refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <form className="node-websites" onSubmit={save}>
    <header><div><small>NODE.JS MULTI-SITE</small><h2>Five websites, one node</h2><p>Each website runs as its own Node.js process and is available under a fixed path from /1 to /5.</p></div><button type="submit" disabled={busy || vm.status !== "running"}><Save /> {busy ? "Applying routes…" : "Save websites"}</button></header>
    <div className="node-website-list">{websites.map(site => {
      const active = vm.websites?.some(item => Number(item.slot) === site.slot);
      const slotDomain = vm.customDomains?.find(item => Number(item.websiteSlot) === site.slot && item.status === "active")?.domain;
      const address = slotDomain ? `https://${slotDomain}` : `https://${hostname}/${site.slot}`;
      return <article className={site.enabled ? "enabled" : ""} key={site.slot}>
        <span className="website-slot">/{site.slot}</span>
        <div><strong>Website {site.slot}</strong><small>{slotDomain ? slotDomain : active ? "Running on its own managed port" : "Not active yet"}</small></div>
        <label><span>Start file</span><input value={site.entryFile} onChange={event => update(site.slot, { entryFile: event.target.value })} disabled={!site.enabled || busy} placeholder={`sites/${site.slot}/server.js`} /></label>
        {active ? <a href={address} target="_blank" rel="noreferrer"><Globe2 /> Open /{site.slot}</a> : <span className="website-pending">/{site.slot}</span>}
        <label className="website-switch"><input type="checkbox" checked={site.enabled} disabled={busy} onChange={event => update(site.slot, { enabled: event.target.checked })} /><i /><span>{site.enabled ? "Enabled" : "Disabled"}</span></label>
      </article>;
    })}</div>
    <footer><span><FileCode2 /><b>How it works</b> Upload every project into a separate folder in Files, then enter its start file here—for example <code>sites/2/server.js</code>.</span><span><Network /><b>Routes</b> Vyron configures Nginx, ports, process restarts and paths automatically.</span></footer>
    {saved && <div className="vh-success"><Check /> All website routes were applied.</div>}
    {error && <div className="vh-error">{error}</div>}
  </form>;
}

function VMDetail({ vm, domains = [], close, refresh }) {
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [revealPassword, setRevealPassword] = useState(false),
    [tab, setTab] = useState(vm?.template === "minecraft" ? "minecraft" : "overview"),
    [upgradeOpen, setUpgradeOpen] = useState(false);
  const [runtimeText, setRuntimeText] = useState(""), [autoRestart, setAutoRestart] = useState(vm?.runtime?.autoRestart !== false), [scheduleEnabled, setScheduleEnabled] = useState(Boolean(vm?.runtime?.schedule?.enabled)), [scheduleHour, setScheduleHour] = useState(String(vm?.runtime?.schedule?.hourUtc ?? 3));
  useEffect(() => {
    setTab(vm?.template === "minecraft" ? "minecraft" : "overview");
    setAutoRestart(vm?.runtime?.autoRestart !== false); setScheduleEnabled(Boolean(vm?.runtime?.schedule?.enabled)); setScheduleHour(String(vm?.runtime?.schedule?.hourUtc ?? 3));
  }, [vm?.id, vm?.template]);
  if (!vm) return null;
  // The full provisioning UI belongs only to the first installation. A normal
  // start/restart may temporarily report `starting`, but the node has already
  // been provisioned and must keep its regular controls and tabs available.
  const minecraftCreating = vm.template === "minecraft" && !vm.minecraft?.installedAt && ["queued", "installing", "starting"].includes(vm.minecraft?.status);
  const minecraftStageText = String(vm.minecraft?.stage || "Creating virtual machine").toLowerCase();
  const minecraftStageIndex = minecraftStageText.includes("starting") ? 3 : minecraftStageText.includes("download") ? 2 : minecraftStageText.includes("resolving") || minecraftStageText.includes("java") ? 1 : 0;
  const history = (vm.metricsHistory || []).map((x) => ({
    ...x,
    ram: vm.ram ? (x.ram / (vm.ram * 1024)) * 100 : 0,
    diskPercent: vm.disk ? ((x.disk || 0) / vm.disk) * 100 : 0,
  }));
  const playerRows = (vm.playerHistory || []).map((sample) => ({
    ...sample,
    percent: sample.maxPlayers ? (Number(sample.players || 0) / Number(sample.maxPlayers)) * 100 : 0,
  })).sort((a, b) => new Date(a.at) - new Date(b.at));
  const currentPlayers = Number(vm.minecraft?.playersOnline || 0);
  const currentMaxPlayers = Number(vm.minecraft?.maxPlayers || 20);
  const diskTotal = vm.metrics?.diskTotalGb || vm.disk,
    diskUsed = vm.metrics?.diskTotalGb ? vm.metrics.diskUsedGb : null,
    diskPercent = diskUsed === null ? 0 : (diskUsed / diskTotal) * 100;
  const customAddress = vm.customDomains?.find((item) => item.status === "active" && !item.websiteSlot)?.domain;
  const publicAddress = vm.template === "minecraft" ? `${customAddress || vm.domain}` :
    ["node", "nginx", "python"].includes(vm.template)
        ? `https://${customAddress || vm.domain}`
        : vm.domain;
  const action = async (act) => {
    if (act === "delete" && !await confirmNodeDeletion(vm.name)) return;
    setBusy(act);
    setError("");
    try {
      await api(`/v1/vms/${vm.name}${act === "delete" ? "" : `/${act}`}`, {
        method: act === "delete" ? "DELETE" : "POST",
        ...(act === "delete" ? { body: JSON.stringify({ confirmation: `DELETE ${vm.name}` }) } : {}),
      });
      await refresh();
      if (act === "delete") close();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };
  const redeploy = async () => {
    setBusy("redeploy"); setError("");
    try { await api(`/v1/vms/${vm.name}/redeploy`, { method: "POST" }); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  const toggleGithubDeploy = async () => {
    setBusy("github"); setError("");
    try { await api(`/v1/vms/${vm.name}/github`, { method: "PATCH", body: JSON.stringify({ autoDeploy: vm.github?.autoDeploy === false }) }); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const assignDomain = async (event) => {
    const id = event.target.value;
    setBusy("domain"); setError("");
    try {
      if (id) await api(`/v1/domains/${id}`, { method: "PATCH", body: JSON.stringify({ vmId: vm.id }) });
      else if (vm.customDomains?.[0]) await api(`/v1/domains/${vm.customDomains[0].id}/unassign`, { method: "POST" });
      await refresh();
    }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  const saveRuntime = async (event) => {
    event.preventDefault(); setBusy("runtime"); setError("");
    try {
      const environment = {};
      for (const line of runtimeText.split("\n")) {
        const trimmed = line.trim(); if (!trimmed) continue;
        const separator = trimmed.indexOf("="); if (separator < 1) throw new Error("Use one variable per line: KEY=value");
        environment[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1);
      }
      await api(`/v1/vms/${vm.name}/runtime-settings`, { method: "PUT", body: JSON.stringify({ environment, autoRestart, schedule: { enabled: scheduleEnabled, hourUtc: Number(scheduleHour) } }) });
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  return (
    <div className="vm-page">
      <header className="vm-page-header">
        <button className="vm-back" onClick={close}>
          <ArrowLeft /> All nodes
        </button>
        <div className="vm-page-identity">
          <span className="server-icon">
            <Server />
          </span>
          <div>
            <small>COMPUTE NODE</small>
            <h1>{vm.name}</h1>
            <p>
              <i className={`vh-dot ${vm.status}`} />
              {nodeStatusLabel(vm.status, vm.minecraft)} · {vm.template} · {vm.plan}
            </p>
          </div>
        </div>
        <div className="vm-page-actions">
          {vm.status === "running" && !minecraftCreating ? (
            <button disabled={busy} onClick={() => action("stop")}>
              <Power /> Shut down
            </button>
          ) : (
            !["provisioning", "queued", "failed"].includes(vm.status) && (
              <button disabled={busy} onClick={() => action("start")}>
                <Play /> Start node
              </button>
            )
          )}
          <button
            className="danger"
            disabled={busy || minecraftCreating || ["provisioning", "queued"].includes(vm.status)}
            onClick={() => action("delete")}
          >
            <Trash2 /> Delete
          </button>
        </div>
      </header>
      <nav className="vm-tabs">
        {[
          ["overview", "Overview", Activity],
          ...(vm.template === "minecraft" ? [["minecraft", "Minecraft", Gamepad2]] : []),
          ...(vm.template === "minecraft" ? [["extensions", "Marketplace", Package]] : []),
          ...(vm.template === "node" ? [["websites", "Websites", Globe2]] : []),
          ["terminal", "Web terminal", SquareTerminal],
          ["files", "Files", FileCode2],
          ["network", "Network", Network],
          ["domains", "Domains", Globe2],
           ...(["node", "nginx"].includes(vm.template) ? [["logs", "Live logs", Activity]] : []),
           ...(vm.template === "node" ? [["runtime", "Runtime", Settings]] : []),
          ["backups", "Backups", Database],
        ].map(([id, label, Icon]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            disabled={minecraftCreating && !["overview", "minecraft"].includes(id)}
            onClick={() => setTab(id)}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>
      <div className="vm-detail-body">
        {vm.deployment && (
          <div className={`node-deployment ${vm.deployment.status}`}>
            <span>
              {vm.deployment.status === "deployed" ? (
                <Check />
              ) : (
                <FileArchive />
              )}
            </span>
            <div>
              <strong>
                {vm.deployment.status === "deployed"
                  ? "Project deployed"
                  : vm.deployment.status === "failed"
                    ? "Project deployment failed"
                    : vm.deployment.status === "deploying"
                      ? "Installing and starting your project…"
                      : vm.github ? "GitHub deployment queued" : "Project ZIP queued for deployment"}
              </strong>
              <p>
                {vm.deployment.status === "failed"
                  ? vm.deployment.error
                  : `${vm.deployment.fileName} · ${publicAddress}`}
              </p>
            </div>
            <em>{vm.deployment.status}</em>
            {vm.template === "node" && vm.deployment.status === "failed" && /environment variable|is missing|fehlt/i.test(vm.deployment.error || "") && <button className="github-redeploy" type="button" onClick={() => { const required = String(vm.deployment.error || "").match(/\b([A-Z][A-Z0-9_]{2,63})\b(?=\s+(?:fehlt|is missing|required))/i)?.[1]?.toUpperCase(); if (required && !runtimeText.trim()) setRuntimeText(`${required}=`); setTab("runtime"); }}><Settings /> Add required variable</button>}
            {vm.github && <><button className="github-redeploy" disabled={busy || vm.deployment.status === "deploying"} onClick={toggleGithubDeploy}><GitBranch /> Auto-deploy {vm.github.autoDeploy === false ? "off" : "on"}</button><button className="github-redeploy" disabled={busy || vm.deployment.status === "deploying"} onClick={redeploy}><RefreshCw /> {busy === "redeploy" ? "Queued…" : "Pull & redeploy"}</button></>}
          </div>
        )}
        {vm.template === "minecraft" && minecraftCreating && (
          <div className={`minecraft-provision ${vm.minecraft?.status || "queued"}`}>
            <span className="minecraft-cube"><Gamepad2 /><i /><i /></span>
            <div><small>{(vm.minecraft?.loader || "minecraft").toUpperCase()} {vm.minecraft?.version || "1.21.11"}</small><strong>Your Minecraft node is being prepared</strong><p>{vm.minecraft?.stage || "Creating virtual machine"}. Controls unlock automatically when the server responds.</p><div className="provision-stages">{["VM", "Java", "Download", "Start"].map((label, index) => <span className={index < minecraftStageIndex ? "done" : index === minecraftStageIndex ? "active" : ""} key={label}><i />{label}</span>)}</div></div>
            <em><LoaderCircle className="spin" /> CREATING</em>
          </div>
        )}
        {tab === "overview" && diskPercent >= 80 && (
          <div className="storage-warning">
            <span>
              <HardDrive />
            </span>
            <div>
              <strong>
                You have used {diskPercent.toFixed(0)}% of your storage
              </strong>
              <p>
                Upgrade now to keep deployments and system updates running
                smoothly.
              </p>
            </div>
            <button onClick={() => setUpgradeOpen(true)}>
              Upgrade resources <ChevronRight />
            </button>
          </div>
        )}
        {tab === "overview" && (
          <div className="vm-dashboard">
            <div className="vm-stat-grid">
              <article className="violet">
                <header>
                  <span>
                    <Cpu />
                  </span>
                  <small>CPU USAGE</small>
                  <em>{vm.cpu} vCPU</em>
                </header>
                <strong>{vm.metrics?.cpu?.toFixed?.(1) || "0.0"}%</strong>
                <MiniGraph data={history} metric="cpu" />
              </article>
              <article className="green">
                <header>
                  <span>
                    <Database />
                  </span>
                  <small>MEMORY</small>
                  <em>of {vm.ram} GB</em>
                </header>
                <strong>
                  {vm.metrics?.usedRamMb
                    ? `${Math.round(vm.metrics.usedRamMb)} MB`
                    : "—"}
                </strong>
                <MiniGraph data={history} metric="ram" />
              </article>
              <article className="orange">
                <header>
                  <span>
                    <HardDrive />
                  </span>
                  <small>STORAGE USED</small>
                  <button
                    className="vm-card-upgrade"
                    onClick={() => setUpgradeOpen(true)}
                  >
                    Upgrade
                  </button>
                </header>
                <strong>
                  {diskUsed === null
                    ? "Measuring…"
                    : `${diskUsed.toFixed(1)} GB`}
                </strong>
                <small className="stat-capacity">
                  of {diskTotal.toFixed(0)} GB · {diskPercent.toFixed(0)}%
                </small>
                <MiniGraph data={history} metric="diskPercent" />
              </article>
              <article className="blue">
                <header>
                  <span>
                    <Globe2 />
                  </span>
                  <small>NETWORK I/O</small>
                  <em>{(vm.metrics?.networkMbps || 0).toFixed(2)} Mbps</em>
                </header>
                <strong>
                  {vm.metrics?.networkTotalMb
                    ? `${vm.metrics.networkTotalMb.toFixed(1)} MB`
                    : "0.0 MB"}
                </strong>
                <MiniGraph data={history} metric="network" autoScale />
              </article>
            </div>
            <div className="vm-overview-grid">
              <section className="vm-summary-panel">
                <header>
                  <div>
                    <h2>Node overview</h2>
                    <p>Configuration and connection details</p>
                  </div>
                  <span>
                    <i />
                    {nodeStatusLabel(vm.status, vm.minecraft)}
                  </span>
                </header>
                <div className="vm-summary-row">
                  <span className="server-icon">
                    <Server />
                  </span>
                  <div>
                    <strong>{vm.name}</strong>
                    <small>
                      {vm.template} · {vm.plan}
                    </small>
                  </div>
                  <dl>
                    <div>
                      <dt>vCPU</dt>
                      <dd>{vm.cpu}</dd>
                    </div>
                    <div>
                      <dt>RAM</dt>
                      <dd>{vm.ram} GB</dd>
                    </div>
                    <div>
                      <dt>Disk</dt>
                      <dd>{vm.disk} GB</dd>
                    </div>
                  </dl>
                </div>
                <div className="vm-connect">
                  <label>
                    Service address
                    <code>
                      {publicAddress}
                      <CopyButton
                        value={publicAddress}
                        label="Copy service address"
                      />
                    </code>
                  </label>
                  <label>
                    SSH command
                    <code>
                      {vm.remoteAccess ? `ssh${vm.remoteAccess.sshPort !== 22 ? ` -p ${vm.remoteAccess.sshPort}` : ""} ${vm.remoteAccess.username}@${vm.remoteAccess.address}` : "Preparing secure SSH access…"}
                      {vm.remoteAccess && <CopyButton value={`ssh${vm.remoteAccess.sshPort !== 22 ? ` -p ${vm.remoteAccess.sshPort}` : ""} ${vm.remoteAccess.username}@${vm.remoteAccess.address}`} label="Copy SSH command" />}
                    </code>
                  </label>
                  {vm.initialPassword && (
                    <label>
                      Password
                      <code className="credential-password">
                        <span className={revealPassword ? "revealed" : "masked"}>
                          {revealPassword
                            ? vm.initialPassword
                            : "••••••••••••••••"}
                        </span>
                        <span className="credential-actions">
                          <button
                          type="button"
                          className={`reveal-action ${revealPassword ? "active" : ""}`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setRevealPassword((visible) => !visible);
                          }}
                          title={
                            revealPassword ? "Hide password" : "Show password"
                          }
                          aria-label={
                            revealPassword ? "Hide password" : "Show password"
                          }
                          aria-pressed={revealPassword}
                        >
                          {revealPassword ? <EyeOff /> : <Eye />}
                          </button>
                          <CopyButton
                            value={vm.initialPassword}
                            label="Copy password"
                          />
                        </span>
                      </code>
                    </label>
                  )}
                </div>
              </section>
              <section className="vm-activity-panel">
                <header>
                  <div>
                    <h2>Node activity</h2>
                    <p>Recent infrastructure events</p>
                  </div>
                  <span>
                    <i /> LIVE
                  </span>
                </header>
                <div>
                  {(vm.events || []).slice(0, 5).map((event) => <article key={event.id}>
                    <span>
                      {event.severity === "critical" ? <Flag /> : event.type?.includes("deploy") ? <FileArchive /> : <Activity />}
                    </span>
                    <div>
                      <strong>{event.title}</strong>
                      <p>{event.detail}</p>
                      <small>{new Date(event.createdAt).toLocaleString("en-GB")}</small>
                    </div>
                  </article>)}
                  {!vm.events?.length && vm.deployment && (
                    <article>
                      <span>
                        <FileArchive />
                      </span>
                      <div>
                        <strong>Project {vm.deployment.status}</strong>
                        <p>{vm.deployment.fileName}</p>
                        <small>
                          {vm.deployment.deployedAt
                            ? new Date(vm.deployment.deployedAt).toLocaleString(
                                "en-GB",
                              )
                            : "automatic deployment"}
                        </small>
                      </div>
                    </article>
                  )}
                  {!vm.events?.length && <article><span><ShieldCheck /></span><div><strong>Secure connection ready</strong><p>Protected remote access</p><small>EU Central</small></div></article>}
                </div>
                <button onClick={() => setTab("terminal")}>
                  Open web terminal <ChevronRight />
                </button>
              </section>
            </div>
            <section className="vm-graph-panel vm-resource-panel">
              <header>
                <div>
                  <h3>Resource usage</h3>
                  <p>Live trend and capacity · hover for exact values</p>
                </div>
                <span>
                  <i /> sampling every 5s
                </span>
              </header>
              <div className="vm-graph-wrap">
                <div className="y-axis">
                  <span>100%</span>
                  <span>75%</span>
                  <span>50%</span>
                  <span>25%</span>
                  <span>0%</span>
                </div>
                <LiveGraph data={history} />
              </div>
              <footer>
                <span>
                  <i className="cpu" />
                  CPU <b>{vm.metrics?.cpu?.toFixed?.(1) || "0.0"}%</b>
                </span>
                <span>
                  <i className="ram" />
                  Memory{" "}
                  <b>
                    {vm.metrics?.usedRamMb
                      ? `${Math.round((vm.metrics.usedRamMb / (vm.ram * 1024)) * 100)}%`
                      : "—"}
                  </b>
                </span>
              </footer>
            </section>
            {vm.template === "minecraft" && (
              <section className="ent-panel ent-usage player-usage minecraft-player-usage">
                <header><div><h2>Player history</h2><p>Live player count for {vm.name} · hover for exact values</p></div><span className="usage-live"><i /> LIVE</span></header>
                <div className="ent-chart"><div className="y-axis"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div><div className="plot"><PlayerGraph data={playerRows} /><div className="x-axis"><span>Older</span><span>Live samples</span><span>Now</span></div></div></div>
                <footer><span><i className="player" /> Online players <b>{currentPlayers} / {currentMaxPlayers}</b></span><span><i className="ram" /> Server <b>{vm.name}</b></span></footer>
              </section>
            )}
          </div>
        )}
        {tab === "terminal" && <LiveKvmTerminal vm={vm} />}
        {tab === "websites" && <NodeWebsites vm={vm} refresh={refresh} />}
        {tab === "files" && <NodeFiles vm={vm} />}
        {tab === "minecraft" && <MinecraftConsole vm={vm} refresh={refresh} />}
        {tab === "extensions" && <MinecraftExtensions vm={vm} refresh={refresh} />}
        {tab === "logs" && <NodeLogs vm={vm} />}
        {tab === "runtime" && <form className="vm-info-grid runtime-settings" onSubmit={saveRuntime}>
          <section><h3>Node.js runtime</h3><p className="vm-muted">Environment values stay on the server and are never returned to the browser.</p><label>Environment variables<textarea value={runtimeText} onChange={e => setRuntimeText(e.target.value)} placeholder={'NODE_ENV=production\nPUBLIC_URL=https://example.com'} spellCheck="false" /></label><small>{vm.runtime?.environmentKeys?.length || 0} variables currently configured</small></section>
          <section><h3>Reliability</h3><label className="runtime-toggle"><input type="checkbox" checked={autoRestart} onChange={e => setAutoRestart(e.target.checked)} /><span><b>Restart service on failure</b><small>systemd starts the Node.js process again automatically.</small></span></label><label className="runtime-toggle"><input type="checkbox" checked={scheduleEnabled} onChange={e => setScheduleEnabled(e.target.checked)} /><span><b>Daily maintenance restart</b><small>Restart the Node.js service once per day (UTC).</small></span></label>{scheduleEnabled && <label>Restart hour (UTC)<input type="number" min="0" max="23" value={scheduleHour} onChange={e => setScheduleHour(e.target.value)} /></label>}<button type="submit" disabled={busy === "runtime"}><Save /> {busy === "runtime" ? "Applying…" : "Save runtime settings"}</button></section>
        </form>}
        {tab === "network" && (
          <div className="vm-info-grid full">
            <section>
              <h3>Remote access</h3>
              <dl>
                <div>
                  <dt>Web terminal</dt>
                  <dd>Available worldwide</dd>
                </div>
                <div>
                  <dt>File manager</dt>
                  <dd>Available in dashboard</dd>
                </div>
                <div>
                  <dt>Connection</dt>
                  <dd>Encrypted</dd>
                </div>
                <div><dt>SSH</dt><dd>{vm.remoteAccess ? <code className="unified-copy-field">{`ssh${vm.remoteAccess.sshPort && vm.remoteAccess.sshPort !== 22 ? ` -p ${vm.remoteAccess.sshPort}` : ""} ${vm.remoteAccess.username}@${vm.remoteAccess.address}`}<CopyButton value={`ssh${vm.remoteAccess.sshPort && vm.remoteAccess.sshPort !== 22 ? ` -p ${vm.remoteAccess.sshPort}` : ""} ${vm.remoteAccess.username}@${vm.remoteAccess.address}`} label="Copy SSH command" /></code> : "Preparing"}</dd></div>
                <div><dt>TCP services</dt><dd>{vm.remoteAccess?.tcpPorts?.join(", ") || "Preparing"}</dd></div>
              </dl>
            </section>
            <section>
              <h3>Website & services</h3>
              <dl>
                <div>
                  <dt>Website address</dt>
                  <dd>{publicAddress}</dd>
                </div>
                <div>
                  <dt>Website status</dt>
                  <dd>
                    {vm.route?.status === "active"
                      ? "Active"
                      : "Preparing"}
                  </dd>
                </div>
                <div>
                  <dt>Application</dt>
                  <dd>
                    {["node", "nginx"].includes(vm.template)
                        ? `Web · ${vm.template === "node" ? "Node.js" : "Nginx"}`
                        : "Managed server"}
                  </dd>
                </div>
                <div>
                  <dt>Protection</dt>
                  <dd>Enabled automatically</dd>
                </div>
                <div>
                  <dt>Region</dt>
                  <dd>EU Central</dd>
                </div>
              </dl>
              <p className="vm-muted">
                Vyron automatically connects your domain to the application
                running on this node.
              </p>
            </section>
          </div>
        )}
        {tab === "domains" && (
          <div className="node-domains-tab">
            <section className="node-domain-hero">
              <div><span><Globe2 /></span><div><small>PRIMARY DOMAIN</small><h2>{customAddress || vm.domain}</h2><p>Your web application is served through this hostname.</p></div></div>
              {["node", "nginx", "python"].includes(vm.template) && <a href={publicAddress} target="_blank" rel="noreferrer"><Globe2 /> Open address</a>}
            </section>
            <div className="node-domain-grid">
              <section className="vh-panel node-domain-settings">
                <header><div><h3>Domain settings</h3><p>Choose which verified domain should point to this node.</p></div><Settings /></header>
                <label>Primary domain<select className="node-domain-select" value={vm.customDomains?.[0]?.id || ""} onChange={assignDomain} disabled={busy === "domain"}><option value="">{vm.domain} · Vyron domain</option>{domains.filter((item) => item.verifiedAt).map((item) => <option key={item.id} value={item.id}>{item.domain}{item.vmId && item.vmId !== vm.id ? " · move from another node" : ""}</option>)}</select></label>
                <div className="domain-setting-row"><span><ShieldCheck /><b>HTTPS protection</b><small>Encrypted connections are required</small></span><em>Enabled</em></div>
                <div className="domain-setting-row"><span><Activity /><b>Service port</b><small>{vm.deployment?.appPort ? "Detected automatically during deployment" : "Default HTTP service port"}</small></span><em>{vm.deployment?.appPort || 80}</em></div>
                <div className="domain-setting-row"><span><Network /><b>Route status</b><small>Traffic is forwarded to this node</small></span><em>{vm.route?.status || "preparing"}</em></div>
              </section>
              <section className="vh-panel node-domain-dns">
                <header><div><h3>DNS configuration</h3><p>Records required at your DNS provider.</p></div><Globe2 /></header>
                {vm.customDomains?.[0] ? vm.customDomains[0].dnsManaged ? <div className="node-domain-automatic"><span><Check /></span><h4>Fully managed by Vyron</h4><p>DNS, routing and SSL are configured and renewed automatically for <b>{vm.customDomains[0].domain}</b>.</p><small><i /> No manual DNS records required</small></div> : <><div className="node-dns-status"><Check /><span><b>Ownership verified</b><small>{vm.customDomains[0].domain}</small></span></div><label><span>Record type</span><code>CNAME</code></label><label><span>Name</span><code>{vm.customDomains[0].domain}<CopyButton value={vm.customDomains[0].domain} label="Copy CNAME name" /></code></label><label><span>Target</span><code>{vm.customDomains[0].cnameTarget || "customers.vyronhosting.com"}<CopyButton value={vm.customDomains[0].cnameTarget || "customers.vyronhosting.com"} label="Copy CNAME target" /></code></label><p className="node-dns-note">DNS changes can take some time to propagate. HTTP services are routed automatically.</p></> : <div className="node-domain-empty"><Globe2 /><h4>Using the included Vyron domain</h4><p>No DNS setup is required. Add and verify a custom domain in the Domains section to select it here.</p></div>}
              </section>
            </div>
          </div>
        )}
        {tab === "backups" && (
          <section className="vm-placeholder">
            <Database />
            <h3>Backups are ready to configure</h3>
            <p>
              No snapshot policy is active yet. The node disk remains on secure
              Vyron storage.
            </p>
            <button disabled>Configure backup policy</button>
          </section>
        )}
        {error && <div className="vh-error">{error}</div>}
      </div>
      {upgradeOpen && (
        <StorageUpgrade
          vm={vm}
          close={() => setUpgradeOpen(false)}
          refresh={refresh}
        />
      )}
    </div>
  );
}

function MinecraftConsole({ vm, refresh }) {
  const [status, setStatus] = useState(vm.minecraft || {}), [logs, setLogs] = useState(""), [command, setCommand] = useState(""), [busy, setBusy] = useState(""), [error, setError] = useState(""), consoleRef = useRef(null);
  const ready = status.status === "running";
  const serverAddress = vm.domain;
  const sshCommand = vm.remoteAccess
    ? `ssh${vm.remoteAccess.sshPort && vm.remoteAccess.sshPort !== 22 ? ` -p ${vm.remoteAccess.sshPort}` : ""} ${vm.remoteAccess.username}@${vm.remoteAccess.address}`
    : "";
  const load = async () => {
    try {
      const next = await api(`/v1/vms/${vm.name}/minecraft/status`); setStatus(next); setError("");
      if (!["queued", "installing"].includes(next.status)) { const output = await api(`/v1/vms/${vm.name}/minecraft/logs?lines=160`); setLogs(output.output || ""); }
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { let active = true; const poll = async () => { if (active) await load(); }; poll(); const timer = setInterval(poll, 3000); return () => { active = false; clearInterval(timer); }; }, [vm.name]);
  useEffect(() => { if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight; }, [logs, status.status]);
  const send = async event => {
    event.preventDefault(); const value = command.trim(); if (!value || busy || !ready) return;
    setBusy("command"); setError("");
    try { const result = await api(`/v1/vms/${vm.name}/minecraft/command`, { method: "POST", body: JSON.stringify({ command: value }) }); setLogs(current => `${current}\n> ${value}\n${result.output || "Command sent."}`.trim()); setCommand(""); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const control = async action => {
    setBusy(action); setError("");
    try { await api(`/v1/vms/${vm.name}/minecraft/${action}`, { method: "POST" }); await load(); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  return <div className="minecraft-panel">
    <section className="minecraft-hero">
      <span className="minecraft-cube"><Gamepad2 /><i /><i /></span>
      <div className="minecraft-identity"><small>{(status.loader || vm.minecraft?.loader || "minecraft").toUpperCase()} SERVER · JAVA 21</small><h2>{vm.name}</h2><div className="minecraft-addresses"><label><span>SERVER ADDRESS</span><code>{serverAddress}<CopyButton value={serverAddress} label="Copy server address" /></code></label><label><span>SSH COMMAND</span><code>{sshCommand || "Preparing external access…"}{sshCommand && <CopyButton value={sshCommand} label="Copy SSH command" />}</code></label></div></div>
      <div className="minecraft-controls">{status.status === "failed" ? <button disabled={busy} onClick={() => control("retry")}><RefreshCw /> Retry installation</button> : <button disabled={busy || ["queued", "installing"].includes(status.status)} onClick={() => control(status.status === "stopped" ? "start" : "stop")}>{status.status === "stopped" ? <Play /> : <Power />}{status.status === "stopped" ? "Start" : "Stop"}</button>}<button disabled={busy || !ready} onClick={() => control("restart")}><RotateCcw /> Restart</button></div>
    </section>
    <div className="minecraft-stat-grid">
      <article><Users /><span><small>PLAYERS ONLINE</small><strong>{status.playersOnline || 0} <em>/ {status.maxPlayers || vm.minecraft?.maxPlayers || 20}</em></strong></span></article>
      <article><Package /><span><small>SERVER SOFTWARE</small><strong>{(status.loader || vm.minecraft?.loader || "Minecraft").replace(/^./, value => value.toUpperCase())} <em>{status.version || vm.minecraft?.version}</em></strong></span></article>
      <article><Activity /><span><small>SERVER STATUS</small><strong className={status.status}>{nodeStatusLabel(vm.status, status)}</strong></span></article>
    </div>
    {status.players?.length > 0 && <section className="minecraft-players"><header><h3>Online players</h3><span>{status.players.length} connected</span></header><div>{status.players.map(player => <span key={player}><i />{player}</span>)}</div></section>}
    <section className="minecraft-console">
      <header><div><SquareTerminal /><span><b>Live server console</b><small>Vyron Server API · process stdin · refreshes every 3 seconds</small></span></div><i className={ready ? "live-pulse" : ""} /></header>
      {error && <div className="vh-error">{error}</div>}
      <pre ref={consoleRef}>{["queued", "installing"].includes(status.status) ? `${status.stage || "Creating virtual machine"}…\nThe console unlocks when the server is fully ready.` : logs || `Waiting for ${status.loader || vm.minecraft?.loader || "Minecraft"} output…`}</pre>
      <div className="minecraft-quick">{["list", "save-all", "whitelist list", "say Welcome to the server!"].map(value => <button key={value} disabled={!ready} onClick={() => setCommand(value)}>{value}</button>)}</div>
      <form onSubmit={send}><span>&gt;</span><input value={command} onChange={e => setCommand(e.target.value)} disabled={!ready} placeholder={ready ? "Enter a Minecraft command without /" : "Console is available when the server is ready"} /><button disabled={!ready || busy === "command" || !command.trim()}><Send /> Send</button></form>
    </section>
  </div>;
}

function MinecraftExtensions({ vm, refresh }) {
  const defaultFilter = ["fabric", "forge"].includes(vm.minecraft?.loader) ? "mod" : "plugin";
  const [query, setQuery] = useState(""), [filter, setFilter] = useState(defaultFilter), [results, setResults] = useState([]), [installed, setInstalled] = useState([]), [meta, setMeta] = useState(null), [busy, setBusy] = useState("search"), [error, setError] = useState(""), [selected, setSelected] = useState(null), [selectedVersion, setSelectedVersion] = useState("");
  const supported = ["paper", "purpur", "folia", "fabric", "forge"].includes(vm.minecraft?.loader);
  const loadInstalled = async () => {
    if (!supported) return;
    try { const result = await api(`/v1/vms/${vm.name}/minecraft/extensions`); setInstalled(result.files || []); }
    catch (e) { setError(e.message); }
  };
  const searchExtensions = async (event, options = {}) => {
    event?.preventDefault(); if (!supported) return; const nextFilter = options.type || filter, append = options.append === true, offset = append ? results.length : 0; setBusy(append ? "more" : "search"); setError("");
    try { const result = await api(`/v1/vms/${vm.name}/minecraft/extensions/search?query=${encodeURIComponent(query.trim())}&type=${encodeURIComponent(nextFilter)}&offset=${offset}`); setResults((current) => append ? [...current, ...(result.results || [])] : (result.results || [])); setMeta(result); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  useEffect(() => { searchExtensions(); loadInstalled(); }, [vm.name]);
  const openProject = async (project) => {
    setSelected({ ...project, loading: true }); setSelectedVersion(""); setError("");
    try { const detail = await api(`/v1/vms/${vm.name}/minecraft/extensions/${project.id}?type=${encodeURIComponent(filter)}`); setSelected(detail); setSelectedVersion(detail.versions?.[0]?.id || ""); }
    catch (e) { setSelected(null); setError(e.message); }
  };
  const install = async (project, versionId = "") => {
    if (!await siteConfirm({ title: `Install ${project.title}?`, message: "Required dependencies will be installed and the Minecraft server will restart.", confirmLabel: "Install" })) return;
    setBusy(project.id); setError("");
    try { await api(`/v1/vms/${vm.name}/minecraft/extensions/install`, { method: "POST", body: JSON.stringify({ projectId: project.id, ...(versionId ? { versionId } : {}) }) }); await loadInstalled(); await refresh(); setSelected(null); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const remove = async (filename) => {
    if (!await siteConfirm({ title: `Remove ${filename}?`, message: "The extension will be removed and the Minecraft server will restart.", confirmLabel: "Remove", danger: true })) return;
    setBusy(filename); setError("");
    try { await api(`/v1/vms/${vm.name}/minecraft/extensions/${encodeURIComponent(filename)}`, { method: "DELETE" }); await loadInstalled(); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  if (!supported) return <section className="minecraft-extension-empty"><Package /><h2>Mods and plugins need a compatible loader</h2><p>Vanilla does not load server extensions. Create a Paper, Purpur or Folia node for plugins, or a Fabric or Forge node for mods.</p></section>;
  return <div className="minecraft-extensions">
    <section className="extension-head"><div><span><Package /></span><div><small>POWERED BY MODRINTH</small><h2>Minecraft Marketplace</h2><p>Browse projects for Minecraft {vm.minecraft.version}. Installation is enabled only when the project matches {vm.minecraft.loader}.</p></div></div><nav className="extension-filters">{[["plugin", "Plugins"], ["mod", "Mods"], ["modpack", "Modpacks"]].map(([type, label]) => <button type="button" className={filter === type ? "active" : ""} key={type} onClick={() => { setFilter(type); searchExtensions(null, { type }); }}>{label}</button>)}</nav><form onSubmit={searchExtensions}><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${filter === "plugin" ? "plugins" : filter === "mod" ? "mods" : "modpacks"}…`} /><button disabled={busy === "search"}>{busy === "search" ? <LoaderCircle className="spin" /> : <Search />} Search</button></form></section>
    {error && <div className="vh-error">{error}</div>}
    <section className="installed-extensions"><header><div><h3>Installed</h3><p>JAR files currently active in the server’s {["fabric", "forge"].includes(vm.minecraft.loader) ? "mods" : "plugins"} folder.</p></div><span>{installed.length}</span></header><div>{installed.length ? installed.map((item) => <article key={item.filename}><Package /><code>{item.filename}</code><button disabled={Boolean(busy)} onClick={() => remove(item.filename)}><Trash2 /> Remove</button></article>) : <p>No managed extensions installed yet.</p>}</div></section>
    <section className="extension-results"><header><h3>{filter === "plugin" ? "Plugins" : filter === "mod" ? "Mods" : "Modpacks"}</h3><span>{meta?.total ? `Showing ${results.length.toLocaleString("en-GB")} of ${meta.total.toLocaleString("en-GB")}` : "Popular projects"}</span></header><div>{results.map((project) => <article className="extension-project" role="button" tabIndex="0" key={project.id} onClick={() => openProject(project)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openProject(project); }}>{project.iconUrl ? <img src={project.iconUrl} alt="" loading="lazy" /> : <span><Package /></span>}<div><small><em className={`extension-type ${project.type}`}>{project.type}</em> {project.author}</small><h3>{project.title}</h3><p>{project.description}</p><footer>{project.categories.slice(0, 3).map((category) => <em key={category}>{category}</em>)}<b>{new Intl.NumberFormat("en", { notation: "compact" }).format(project.downloads || 0)} downloads</b></footer></div><button disabled={Boolean(busy) || !project.installable} onClick={(event) => { event.stopPropagation(); install(project); }}>{busy === project.id ? <LoaderCircle className="spin" /> : project.installable ? <Plus /> : <ShieldCheck />} {project.installable ? "Install" : project.type === "modpack" ? "View versions" : `No ${vm.minecraft.version} release`}</button></article>)}</div>{!results.length && busy !== "search" && <p className="extension-no-results">No results found. Try another search.</p>}{results.length < Number(meta?.total || 0) && <button className="extension-load-more" disabled={Boolean(busy)} onClick={() => searchExtensions(null, { append: true })}>{busy === "more" ? <LoaderCircle className="spin" /> : <Plus />} Load more</button>}</section>
    {selected && <div className="marketplace-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}><section className="marketplace-detail" role="dialog" aria-modal="true" aria-label={selected.title || "Project details"}>{selected.loading ? <div className="marketplace-detail-loading"><LoaderCircle className="spin" /><b>Loading project…</b></div> : <><header><div>{selected.iconUrl ? <img src={selected.iconUrl} alt="" /> : <span><Package /></span>}<div><small><em className={`extension-type ${selected.type}`}>{selected.type}</em> MODRINTH PROJECT</small><h2>{selected.title}</h2><p>{selected.description}</p></div></div><button type="button" aria-label="Close" onClick={() => setSelected(null)}>×</button></header>{selected.gallery?.length > 0 && <div className="marketplace-gallery">{selected.gallery.slice(0, 4).map((image, index) => <img key={image.url} src={image.url} alt={image.title || `${selected.title} screenshot ${index + 1}`} loading="lazy" />)}</div>}<div className="marketplace-detail-grid"><main><h3>About this project</h3><p className="marketplace-body">{selected.body || selected.description}</p></main><aside><div className="marketplace-numbers"><span><b>{new Intl.NumberFormat("en", { notation: "compact" }).format(selected.downloads || 0)}</b>Downloads</span><span><b>{new Intl.NumberFormat("en", { notation: "compact" }).format(selected.followers || 0)}</b>Followers</span></div><h3>Compatible releases</h3><p>For {vm.minecraft.loader} {vm.minecraft.version}</p>{selected.versions?.length ? <><select value={selectedVersion} onChange={(event) => setSelectedVersion(event.target.value)}>{selected.versions.map((version) => <option key={version.id} value={version.id}>{version.versionNumber} · {version.versionType} · {new Date(version.datePublished).toLocaleDateString("en-GB")}</option>)}</select>{selected.versions.find(version => version.id === selectedVersion)?.file && <small>{selected.versions.find(version => version.id === selectedVersion).file.filename} · {(selected.versions.find(version => version.id === selectedVersion).file.size / 1024 / 1024).toFixed(1)} MB</small>}<button className="marketplace-install" disabled={Boolean(busy) || selected.type === "modpack"} onClick={() => install(selected, selectedVersion)}>{busy === selected.id ? <LoaderCircle className="spin" /> : <Plus />} {selected.type === "modpack" ? "Create a new node to use this modpack" : "Install selected version"}</button></> : <div className="marketplace-incompatible">No release supports this node's loader and Minecraft version.</div>}<div className="marketplace-tags">{selected.categories?.map(category => <em key={category}>{category}</em>)}</div>{selected.license && <p className="marketplace-license">License: <b>{selected.license}</b></p>}</aside></div></>}</section></div>}
  </div>;
}

function NodeLogs({ vm }) {
  const [data, setData] = useState({ output: "" }), [error, setError] = useState(""), [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    const load = async () => {
      try { const next = await api(`/v1/vms/${vm.name}/logs?lines=180`); if (active) { setData(next); setError(""); setLoading(false) } }
      catch (e) { if (active) { setError(e.message); setLoading(false) } }
    }
    load(); const timer = setInterval(load, 2500)
    return () => { active = false; clearInterval(timer) }
  }, [vm.name])
  return <section className="web-logs"><header><div><Activity /><span><b>Live application logs</b><small>Node.js and Nginx output · refreshes automatically</small></span></div><i className="live-pulse" /></header>{error ? <div className="vh-error">{error}</div> : <pre>{loading ? "Connecting to the log stream…" : (data.output || "No logs have been emitted yet.")}</pre>}</section>
}

function Instances({ vms, refresh, openVm, openDeploy, canCreate = true }) {
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const action = async (v, act) => {
    if (act === "delete" && !await confirmNodeDeletion(v.name)) return;
    setBusy(v.name + act);
    setError("");
    try {
      await api(`/v1/vms/${v.name}${act === "delete" ? "" : `/${act}`}`, {
        method: act === "delete" ? "DELETE" : "POST",
        ...(act === "delete" ? { body: JSON.stringify({ confirmation: `DELETE ${v.name}` }) } : {}),
      });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };
  const live = vms.filter((v) => v.status !== "deleted");
  return (
    <div className="instances-page">
      <div className="vh-title">
        <div>
          <small>COMPUTE</small>
          <h1>Nodes</h1>
          <p>Manage your compute nodes, deployments and connectivity.</p>
        </div>
        {canCreate && <button className="instances-create" onClick={openDeploy}>
          <Plus /> New node
        </button>}
      </div>
      {error && <div className="vh-error">{error}</div>}
      <section className="instance-catalog ent-panel">
        <header>
          <div>
            <h2>Compute nodes</h2>
            <p>
              {live.length} active resource{live.length === 1 ? "" : "s"} in EU
              Central
            </p>
          </div>
          <span>
            <i /> SERVERS ONLINE
          </span>
        </header>
        {live.length ? (
          <div className="instance-table">
            <div className="instance-table-head">
              <span>NODE</span>
              <span>STATUS</span>
              <span>RESOURCES</span>
              <span>CPU</span>
              <span>MEMORY</span>
              <span />
            </div>
            {live.map((v, i) => (
              <article key={v.id} onClick={() => openVm(v.id)}>
                <span className={`server-icon tone-${i % 3}`}>
                  <Server />
                </span>
                <div className="instance-name">
                  <strong>{v.name}</strong>
                  <small>{v.id}</small>
                </div>
                <em className={v.status}>
                  <i />
                  {nodeStatusLabel(v.status, v.minecraft)}
                </em>
                <div className="instance-resources">
                  <b>{v.cpu} vCPU</b>
                  <small>
                    {v.ram} GB RAM · {v.disk} GB
                  </small>
                </div>
                <label>
                  <b>{v.metrics?.cpu?.toFixed?.(1) || "0.0"}%</b>
                  <i>
                    <span style={{ width: `${v.metrics?.cpu || 0}%` }} />
                  </i>
                </label>
                <label>
                  <b>
                    {v.metrics?.usedRamMb
                      ? `${Math.round(v.metrics.usedRamMb)} MB`
                      : "—"}
                  </b>
                  <i>
                    <span
                      style={{
                        width: `${Math.min(100, ((v.metrics?.usedRamMb || 0) / (v.ram * 1024)) * 100)}%`,
                      }}
                    />
                  </i>
                </label>
                <button title="Open node">
                  <ChevronRight />
                </button>
                <div className="instance-quick">
                  {v.status === "running" ? (
                    <button
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        action(v, "stop");
                      }}
                    >
                      <Power /> Stop
                    </button>
                  ) : (
                    !["provisioning", "queued", "failed"].includes(
                      v.status,
                    ) && (
                      <button
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          action(v, "start");
                        }}
                      >
                        <Play /> Start
                      </button>
                    )
                  )}
                  <button
                    className="danger"
                    disabled={
                      busy || ["provisioning", "queued"].includes(v.status)
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      action(v, "delete");
                    }}
                  >
                    <Trash2 />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="vh-empty">
            <Server />
            <h3>No nodes yet</h3>
            <p>Create your first managed compute node in EU Central.</p>
            {canCreate && <button onClick={openDeploy}>Create node</button>}
          </div>
        )}
      </section>
    </div>
  );
}

function Billing({ orders }) {
  return (
    <div>
      <div className="vh-title">
        <div>
          <small>BILLING</small>
          <h1>Billing</h1>
          <p>Orders, discounts and payment status.</p>
        </div>
      </div>
      <section className="vh-panel">
        <header>
          <div>
            <h2>Order history</h2>
            <p>All charges including coupon discounts</p>
          </div>
        </header>
        {orders.length ? (
          <div className="vh-orders">
            {orders.map((o) => (
              <div key={o.id}>
                <span>
                  <CreditCard />
                  <b>{o.plan}</b>
                  <small>{new Date(o.createdAt).toLocaleString("en-GB")}</small>
                </span>
                <span>
                  <small>Coupon</small>
                  <b>{o.coupon || "—"}</b>
                </span>
                <span>
                  <small>Discount</small>
                  <b>−€{o.discount.toFixed(2)}</b>
                </span>
                <span>
                  <small>Total</small>
                  <b>€{o.total.toFixed(2)}</b>
                </span>
                <em className={o.status}>{o.status}</em>
                {o.status === "paid" && <a className="invoice-link" href={`/api/v1/invoices/${o.id}`} target="_blank" rel="noreferrer"><FileCode2 /> Receipt</a>}
              </div>
            ))}
          </div>
        ) : (
          <div className="vh-empty">
            <CreditCard />
            <h3>No orders yet</h3>
          </div>
        )}
      </section>
    </div>
  );
}

function Helper() {
  const greeting = "Hi — I’m Vyron Copilot. Ask me any general or hosting question. I can also inspect node health and propose safe actions for your approval.";
  const [q, setQ] = useState(""),
    [messages, setMessages] = useState([{ role: "assistant", content: greeting }]),
    [chats, setChats] = useState([]),
    [memories, setMemories] = useState([]),
    [activeChatId, setActiveChatId] = useState(null),
    [sidebarLoading, setSidebarLoading] = useState(true),
    [proposed, setProposed] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const refreshChats = async (preferredId = null) => {
    const data = await api("/v1/ai/chats");
    setChats(data.chats || []); setMemories(data.memories || []);
    return preferredId || data.chats?.[0]?.id || null;
  };
  const openChat = async (id) => {
    if (!id || busy) return;
    setSidebarLoading(true); setError(""); setProposed(null);
    try { const chat = await api(`/v1/ai/chats/${id}`); setActiveChatId(chat.id); setMessages(chat.messages?.length ? chat.messages : [{ role: "assistant", content: greeting }]); }
    catch (e) { setError(e.message); }
    finally { setSidebarLoading(false); }
  };
  const newChat = async () => {
    if (busy) return;
    setSidebarLoading(true); setError(""); setProposed(null);
    try { const chat = await api("/v1/ai/chats", { method: "POST", body: JSON.stringify({}) }); setActiveChatId(chat.id); setMessages(chat.messages); await refreshChats(chat.id); }
    catch (e) { setError(e.message); }
    finally { setSidebarLoading(false); }
  };
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await api("/v1/ai/chats"); if (!mounted) return;
        setChats(data.chats || []); setMemories(data.memories || []);
        if (data.chats?.[0]) { const chat = await api(`/v1/ai/chats/${data.chats[0].id}`); if (mounted) { setActiveChatId(chat.id); setMessages(chat.messages || []); } }
        else { const chat = await api("/v1/ai/chats", { method: "POST", body: "{}" }); if (mounted) { setActiveChatId(chat.id); setMessages(chat.messages || []); setChats([chat]); } }
      } catch (e) { if (mounted) setError(e.message); }
      finally { if (mounted) setSidebarLoading(false); }
    })();
    return () => { mounted = false; };
  }, []);
  const renameChat = async (chat, event) => {
    event.stopPropagation();
    const title = await sitePrompt({ title: "Rename chat", message: "Choose a short name for this conversation.", placeholder: chat.title, confirmLabel: "Rename" });
    if (!title) return;
    try { const updated = await api(`/v1/ai/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) }); setChats(items => items.map(item => item.id === chat.id ? { ...item, ...updated } : item)); }
    catch (e) { setError(e.message); }
  };
  const removeChat = async (chat, event) => {
    event.stopPropagation();
    if (!await siteConfirm({ title: `Delete “${chat.title}”?`, message: "This removes the saved conversation permanently.", confirmLabel: "Delete chat", danger: true })) return;
    try {
      await api(`/v1/ai/chats/${chat.id}`, { method: "DELETE" });
      const remaining = chats.filter(item => item.id !== chat.id); setChats(remaining);
      if (activeChatId === chat.id) { if (remaining[0]) await openChat(remaining[0].id); else await newChat(); }
    } catch (e) { setError(e.message); }
  };
  const addMemory = async () => {
    const content = await sitePrompt({ title: "Add memory", message: "Save a preference or fact that Vyron Copilot should use in future chats.", placeholder: "For example: Prefer concise answers", confirmLabel: "Remember" });
    if (!content) return;
    try { const memory = await api("/v1/ai/memories", { method: "POST", body: JSON.stringify({ content }) }); setMemories(items => [memory, ...items.filter(item => item.id !== memory.id)]); }
    catch (e) { setError(e.message); }
  };
  const removeMemory = async (memory) => {
    try { await api(`/v1/ai/memories/${memory.id}`, { method: "DELETE" }); setMemories(items => items.filter(item => item.id !== memory.id)); }
    catch (e) { setError(e.message); }
  };
  const ask = async (e) => {
    e.preventDefault();
    const message = q.trim(); if (!message || busy || !activeChatId) return;
    const next = [...messages, { role: "user", content: message }];
    setMessages(next); setQ(""); setBusy(true); setError(""); setProposed(null);
    try {
      const result = await api("/v1/ai/chat", { method: "POST", body: JSON.stringify({ message, chatId: activeChatId }) });
      setMessages([...next, { role: "assistant", content: result.answer, sources: result.sources || [], searched: result.searched }]); setProposed(result.proposedAction || null);
      if (result.memory) setMemories(items => [result.memory, ...items.filter(item => item.id !== result.memory.id)]);
      await refreshChats(activeChatId);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const execute = async () => {
    if (!proposed || busy || !await siteConfirm({ title: `Run action on ${proposed.node}?`, message: `${proposed.command || proposed.type}\n\n${proposed.reason}`, confirmLabel: "Run action" })) return;
    setBusy(true); setError("");
    try {
      const response = await api(`/v1/ai/actions/${proposed.id}/execute`, { method: "POST", body: JSON.stringify({ confirm: true }) });
      const output = response.result?.stdout || response.result?.output || response.result?.status || "Action completed successfully.";
      setMessages((items) => [...items, { role: "system", content: String(output).slice(0, 5000) }]); setProposed(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="copilot-page">
      <div className="vh-title">
        <div>
          <small>OPTIONAL ASSISTANCE</small>
          <h1>Vyron Copilot</h1>
          <p>General AI assistance with optional Vyron infrastructure tools.</p>
        </div>
      </div>
      <section className="vh-panel copilot-shell copilot-with-sidebar">
        <aside className="copilot-sidebar">
          <button className="copilot-new" onClick={newChat} disabled={busy}><Plus /> New chat</button>
          <section><header><span><MessageSquare /> Chats</span></header><div className="copilot-chat-list">{chats.map(chat => <button className={chat.id === activeChatId ? "active" : ""} key={chat.id} onClick={() => openChat(chat.id)}><span><b>{chat.title}</b><small>{new Date(chat.updatedAt).toLocaleDateString()}</small></span><i onClick={event => renameChat(chat, event)} title="Rename"><Pencil /></i><i onClick={event => removeChat(chat, event)} title="Delete"><Trash2 /></i></button>)}</div></section>
          <section className="copilot-memory"><header><span><Brain /> Memory</span><button onClick={addMemory} title="Add memory"><Plus /></button></header><div>{memories.map(memory => <article key={memory.id}><p>{memory.content}</p><button onClick={() => removeMemory(memory)} title="Forget"><X /></button></article>)}{!memories.length && <small>No saved memories yet.</small>}</div></section>
        </aside>
        <main className="copilot-main">
          <header><span><Bot /></span><div><h2>Ask anything</h2><p>General knowledge, web search and help with your Vyron workspace.</p></div><em><i /> Safe by design</em></header>
          <div className="copilot-messages">
            {sidebarLoading && <article className="assistant thinking"><span><Bot /></span><div><small>LOADING CHAT</small><p><i /><i /><i /></p></div></article>}
            {!sidebarLoading && messages.map((message, index) => <article className={message.role} key={index}><span>{message.role === "user" ? <UserRound /> : message.role === "system" ? <SquareTerminal /> : <Bot />}</span><div><small>{message.role === "user" ? "YOU" : message.role === "system" ? "ACTION OUTPUT" : "VYRON COPILOT"}</small><p>{message.content}</p>{message.sources?.length > 0 && <nav className="copilot-sources"><small>WEB SOURCES</small>{message.sources.map((source) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}><Globe2 />{source.title}</a>)}</nav>}</div></article>)}
            {busy && <article className="assistant thinking"><span><Bot /></span><div><small>VYRON COPILOT</small><p><i /><i /><i /></p></div></article>}
          </div>
          {proposed && <aside className="copilot-action"><header><ShieldCheck /><div><small>CONFIRMATION REQUIRED</small><b>{proposed.type.replaceAll("_", " ")} on {proposed.node}</b></div></header>{proposed.command && <code>{proposed.command}</code>}<p>{proposed.reason}</p><div><button onClick={() => setProposed(null)}>Dismiss</button><button onClick={execute} disabled={busy}><Play /> Review & run</button></div></aside>}
          {error && <div className="vh-error">{error}</div>}
          <form onSubmit={ask}><input value={q} onChange={(e) => setQ(e.target.value)} maxLength="1200" placeholder="Ask anything legal, search the web, or manage a node…" /><button disabled={busy || !q.trim() || !activeChatId}><Send /></button></form>
          <footer><ShieldCheck /> Chats and approved memory are saved securely <span /> Every infrastructure action requires your confirmation</footer>
        </main>
      </section>
    </div>
  );
}

function AccountSettings({ account, refresh }) {
  const [profile, setProfile] = useState({
      name: account.user.name,
      email: account.user.email,
    }),
    [workspace, setWorkspace] = useState({
      name: account.workspace.name,
      slug: account.workspace.slug,
    }),
    [password, setPassword] = useState({
      currentPassword: "",
      newPassword: "",
    }),
    [invite, setInvite] = useState({ email: "", role: "developer" }),
    [notifications, setNotifications] = useState(account.security?.notifications || { service: false, billing: true, security: true, deployment: false, usage: false, usageThreshold: 80 }),
    [discordWebhook, setDiscordWebhook] = useState(""),
    [twoFactor, setTwoFactor] = useState({ password: "", code: "", setup: null, backupCodes: [] }),
    [support, setSupport] = useState({ tickets: [], subject: "", message: "", priority: "normal", vmId: "" }),
    [referrals, setReferrals] = useState(null),
    [tokenForm, setTokenForm] = useState({ name: "", password: "", operate: false }),
    [passkeyForm, setPasskeyForm] = useState({ name: "This device", password: "" }),
    [newToken, setNewToken] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const mcpEndpoint = "https://app.vyronhosting.com/api/mcp";
  const claudeMcpCommand = `claude mcp add --transport http --scope user vyron ${mcpEndpoint} --header "Authorization: Bearer YOUR_VYRON_TOKEN"`;
  const codexMcpConfig = `[mcp_servers.vyron]\nurl = "${mcpEndpoint}"\nbearer_token_env_var = "VYRON_MCP_TOKEN"`;
  useEffect(() => {
    api("/v1/support/tickets").then((result) => setSupport((current) => ({ ...current, tickets: result.tickets || [] }))).catch(() => {});
    api("/v1/account/referrals").then(setReferrals).catch(() => {});
  }, []);
  const saveProfile = async (e) => {
    e.preventDefault();
    setBusy("profile");
    setError("");
    try {
      await api("/v1/account/profile", {
        method: "PATCH",
        body: JSON.stringify(profile),
      });
      setMessage("Profile saved");
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };
  const saveWorkspace = async (e) => {
    e.preventDefault();
    setBusy("workspace");
    setError("");
    try {
      await api(`/v1/workspaces/${account.workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify(workspace),
      });
      setMessage("Workspace saved");
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };
  const savePassword = async (e) => {
    e.preventDefault();
    setBusy("password");
    setError("");
    try {
      await api("/v1/account/password", {
        method: "PATCH",
        body: JSON.stringify(password),
      });
      setPassword({ currentPassword: "", newPassword: "" });
      setMessage("Password changed");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };
  const addPasskey = async (e) => {
    e.preventDefault(); setBusy("passkey"); setError(""); setMessage("");
    if (!browserSupportsWebAuthn()) { setError("This browser does not support passkeys."); setBusy(""); return; }
    try {
      const begin = await api("/v1/account/passkeys/register/options", { method: "POST", body: JSON.stringify({ password: passkeyForm.password }) });
      const response = await startRegistration({ optionsJSON: begin.options });
      await api("/v1/account/passkeys/register/verify", { method: "POST", body: JSON.stringify({ challengeId: begin.challengeId, response, name: passkeyForm.name }) });
      setPasskeyForm({ name: "This device", password: "" }); setMessage("Passkey added — you can now sign in without a password"); await refresh();
    } catch (e) { setError(e.name === "NotAllowedError" ? "Passkey setup was cancelled or timed out." : e.message); } finally { setBusy(""); }
  };
  const removePasskey = async (passkey) => {
    const passwordValue = await sitePrompt({ title: `Remove ${passkey.name}?`, message: "Enter your current password to remove this passkey.", inputType: "password", placeholder: "Current password", confirmLabel: "Remove passkey", danger: true });
    if (passwordValue === null) return;
    setBusy(passkey.id); setError("");
    try { await api(`/v1/account/passkeys/${encodeURIComponent(passkey.id)}`, { method: "DELETE", body: JSON.stringify({ password: passwordValue }) }); setMessage("Passkey removed"); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const inviteMember = async (e) => {
    e.preventDefault();
    setBusy("invite"); setError("");
    try {
      const result = await api(`/v1/workspaces/${account.workspace.id}/members`, { method: "POST", body: JSON.stringify(invite) });
      setInvite({ email: "", role: "developer" }); setMessage(result.member?.status === "pending" ? "Invitation saved — access activates when the account is registered" : "Workspace member added"); await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const changeMemberRole = async (userId, role) => {
    setBusy(userId); setError("");
    try {
      await api(`/v1/workspaces/${account.workspace.id}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) });
      setMessage("Member role updated"); await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const removeMember = async (member) => {
    if (!await siteConfirm({ title: `Remove ${member.name}?`, message: "This person will lose access to the workspace.", confirmLabel: "Remove member", danger: true })) return;
    setBusy(member.id); setError("");
    try {
      await api(`/v1/workspaces/${account.workspace.id}/members/${member.id}`, { method: "DELETE" });
      setMessage("Workspace member removed"); await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const saveNotifications = async (e) => {
    e.preventDefault(); setBusy("notifications"); setError("");
    try { await api("/v1/account/notifications", { method: "PATCH", body: JSON.stringify(notifications) }); setMessage("Notification preferences saved"); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const createToken = async (e) => {
    e.preventDefault(); setBusy("token"); setError(""); setNewToken("");
    try { const result = await api("/v1/account/api-tokens", { method: "POST", body: JSON.stringify({ name: tokenForm.name, password: tokenForm.password, scopes: tokenForm.operate ? ["read", "operate"] : ["read"] }) }); setNewToken(result.token); setTokenForm({ name: "", password: "", operate: false }); setMessage("API token created — copy it now"); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const revokeToken = async (id) => {
    if (!await siteConfirm({ title: "Revoke API token?", message: "Applications using it will immediately lose access.", confirmLabel: "Revoke token", danger: true })) return;
    setBusy(id); try { await api(`/v1/account/api-tokens/${id}`, { method: "DELETE" }); setMessage("API token revoked"); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const revokeSession = async (session) => {
    if (!await siteConfirm({ title: session.current ? "Sign out this browser?" : "Revoke login session?", message: session.current ? "You will be returned to the sign-in page." : "That browser will immediately lose access.", confirmLabel: session.current ? "Sign out" : "Revoke session", danger: true })) return;
    setBusy(session.id); try { await api(`/v1/account/sessions/${session.id}`, { method: "DELETE" }); if (session.current) location.href = "/login"; else { setMessage("Session revoked"); await refresh(); } } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const connectDiscord = async (e) => {
    e.preventDefault(); setBusy("discord"); setError("");
    try { await api("/v1/account/discord-webhook", { method: "PUT", body: JSON.stringify({ webhookUrl: discordWebhook }) }); setDiscordWebhook(""); setMessage("Discord webhook connected — a test notification was sent"); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const disconnectDiscord = async () => {
    setBusy("discord"); try { await api("/v1/account/discord-webhook", { method: "DELETE" }); setMessage("Discord webhook disconnected"); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const setupTwoFactor = async (e) => {
    e.preventDefault(); setBusy("2fa"); setError("");
    try { const result = await api("/v1/account/2fa/setup", { method: "POST", body: JSON.stringify({ password: twoFactor.password }) }); setTwoFactor({ ...twoFactor, setup: result, code: "" }); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const enableTwoFactor = async () => {
    setBusy("2fa"); setError("");
    try { const result = await api("/v1/account/2fa/enable", { method: "POST", body: JSON.stringify({ code: twoFactor.code }) }); setTwoFactor({ password: "", code: "", setup: null, backupCodes: result.backupCodes || [] }); setMessage("Two-factor authentication enabled"); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const disableTwoFactor = async (e) => {
    e.preventDefault(); setBusy("2fa"); setError("");
    try { await api("/v1/account/2fa/disable", { method: "POST", body: JSON.stringify({ password: twoFactor.password, code: twoFactor.code }) }); setTwoFactor({ password: "", code: "", setup: null, backupCodes: [] }); setMessage("Two-factor authentication disabled"); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const createTicket = async (e) => {
    e.preventDefault(); setBusy("support"); setError("");
    try { const result = await api("/v1/support/tickets", { method: "POST", body: JSON.stringify(support) }); setSupport({ ...support, subject: "", message: "", tickets: [result.ticket, ...support.tickets] }); setMessage("Support ticket created"); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  return (
    <div className="settings-page">
      <div className="vh-title">
        <div>
          <small>ACCOUNT & WORKSPACE</small>
          <h1>Settings</h1>
          <p>Manage your identity, workspace and account security.</p>
        </div>
      </div>
      {message && (
        <div className="settings-success">
          <Check />
          {message}
        </div>
      )}
      {error && <div className="vh-error">{error}</div>}
      <div className="settings-grid">
        <form className="settings-card" onSubmit={saveProfile}>
          <header>
            <UserRound />
            <div>
              <h2>Profile</h2>
              <p>Your personal account information.</p>
            </div>
          </header>
          <label>
            Display name
            <input
              required
              minLength="2"
              value={profile.name}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
          </label>
          <label>
            Email address
            <input
              required
              type="email"
              value={profile.email}
              onChange={(e) =>
                setProfile({ ...profile, email: e.target.value })
              }
            />
          </label>
          <button disabled={busy === "profile"}>
            {busy === "profile" ? "Saving…" : "Save profile"}
          </button>
        </form>
        <form className="settings-card" onSubmit={saveWorkspace}>
          <header>
            <Box />
            <div>
              <h2>Workspace</h2>
              <p>Used for nodes, billing and domains.</p>
            </div>
          </header>
          <label>
            Workspace name
            <input
              required
              minLength="2"
              value={workspace.name}
              onChange={(e) =>
                setWorkspace({ ...workspace, name: e.target.value })
              }
            />
          </label>
          <label>
            Workspace ID
            <div className="slug-input">
              <input
                required
                minLength="3"
                value={workspace.slug}
                onChange={(e) =>
                  setWorkspace({
                    ...workspace,
                    slug: e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9-]/g, ""),
                  })
                }
              />
              <span>.vyron.cloud</span>
            </div>
          </label>
          <button disabled={busy === "workspace" || !account.workspace.permissions?.manage}>
            {busy === "workspace" ? "Saving…" : "Save workspace"}
          </button>
        </form>
        <section className="settings-card team-settings">
          <header>
            <Users />
            <div>
              <h2>Workspace members</h2>
              <p>Give teammates controlled access without sharing your account.</p>
            </div>
            <span className="team-count">{account.workspace.members?.length || 1} members</span>
          </header>
          {account.workspace.permissions?.manage && (
            <form className="team-invite" onSubmit={inviteMember}>
              <input required type="email" placeholder="teammate@example.com" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
              <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
                <option value="admin">Admin</option><option value="developer">Developer</option><option value="viewer">Viewer</option>
              </select>
              <button disabled={busy === "invite"}><Plus />{busy === "invite" ? "Adding…" : "Add member"}</button>
            </form>
          )}
          <div className="team-list">
            {(account.workspace.members || []).map((member) => (
              <article key={member.id}>
                <span className="team-avatar">{member.name.slice(0, 2).toUpperCase()}</span>
                <div><b>{member.name}{member.id === account.user.id && " (you)"}{member.status === "pending" && <em className="pending-member">Pending</em>}</b><small>{member.email}</small></div>
                {member.role === "owner" || !account.workspace.permissions?.manage ? <em className={`team-role ${member.role}`}>{member.role}</em> : (
                  <select disabled={busy === member.id} value={member.role} onChange={(e) => changeMemberRole(member.id, e.target.value)}>
                    <option value="admin">Admin</option><option value="developer">Developer</option><option value="viewer">Viewer</option>
                  </select>
                )}
                {member.role !== "owner" && account.workspace.permissions?.manage && <button className="team-remove" disabled={busy === member.id} onClick={() => removeMember(member)} aria-label={`Remove ${member.name}`}><Trash2 /></button>}
              </article>
            ))}
          </div>
          <footer><span><ShieldCheck /> Admin</span> manages members, billing and nodes <span><FileCode2 /> Developer</span> operates nodes and domains <span><Eye /> Viewer</span> has read-only monitoring</footer>
        </section>
        <form className="settings-card" onSubmit={savePassword}>
          <header>
            <KeyRound />
            <div>
              <h2>Password</h2>
              <p>Use at least eight characters.</p>
            </div>
          </header>
          <label>
            Current password
            <input
              required
              type="password"
              value={password.currentPassword}
              onChange={(e) =>
                setPassword({ ...password, currentPassword: e.target.value })
              }
              autoComplete="current-password"
            />
          </label>
          <label>
            New password
            <input
              required
              minLength="8"
              type="password"
              value={password.newPassword}
              onChange={(e) =>
                setPassword({ ...password, newPassword: e.target.value })
              }
              autoComplete="new-password"
            />
          </label>
          <button disabled={busy === "password"}>
            {busy === "password" ? "Changing…" : "Change password"}
          </button>
        </form>
        <section className="settings-card passkey-settings">
          <header><KeyRound /><div><h2>Passkeys</h2><p>Sign in with Windows Hello, Touch ID or a security key.</p></div></header>
          <form className="passkey-create" onSubmit={addPasskey}>
            <label>Passkey name<input required maxLength="50" value={passkeyForm.name} onChange={(e) => setPasskeyForm({ ...passkeyForm, name: e.target.value })} placeholder="Laptop, phone or security key" /></label>
            <label>Current password<input required type="password" autoComplete="current-password" value={passkeyForm.password} onChange={(e) => setPasskeyForm({ ...passkeyForm, password: e.target.value })} /></label>
            <button disabled={busy === "passkey"}><Plus /> {busy === "passkey" ? "Waiting for device…" : "Add passkey"}</button>
          </form>
          <div className="security-item-list">{(account.security?.passkeys || []).map((passkey) => <article key={passkey.id}><span><b>{passkey.name}</b><small>{passkey.backedUp ? "Synced passkey" : "This device or security key"} · added {new Date(passkey.createdAt).toLocaleDateString("en-GB")}{passkey.lastUsedAt ? ` · last used ${new Date(passkey.lastUsedAt).toLocaleString("en-GB")}` : ""}</small></span><button type="button" aria-label={`Remove ${passkey.name}`} disabled={busy === passkey.id} onClick={() => removePasskey(passkey)}><Trash2 /></button></article>)}{!account.security?.passkeys?.length && <p>No passkeys added yet.</p>}</div>
        </section>
        <form className="settings-card notification-settings" onSubmit={saveNotifications}>
          <header><Activity /><div><h2>Notifications</h2><p>Choose which important alerts may leave the dashboard.</p></div></header>
          {[["service", "Critical node incidents", "Email only when a node fails or goes missing"], ["deployment", "Failed deployments", "Email only when a deployment fails"], ["usage", "Resource usage warnings", `Email at ${notifications.usageThreshold}% usage`], ["billing", "Invoices and payment events", "Important billing emails"], ["security", "Security and login alerts", "Important account security emails"]].map(([key, label, hint]) => <label className="settings-switch" key={key}><input type="checkbox" checked={notifications[key] !== false} onChange={e => setNotifications({ ...notifications, [key]: e.target.checked })} /><span><b>{label}</b><small>{hint}</small></span></label>)}
          {notifications.usage && <label>Usage warning threshold<input type="number" min="50" max="95" step="5" value={notifications.usageThreshold} onChange={e => setNotifications({ ...notifications, usageThreshold: Number(e.target.value) })} /></label>}
          <button disabled={busy === "notifications"}><Save /> {busy === "notifications" ? "Saving…" : "Save notifications"}</button>
        </form>
        <section className="settings-card api-token-settings">
          <header><KeyRound /><div><h2>API tokens</h2><p>Automate Vyron without sharing your password.</p></div></header>
          <form onSubmit={createToken} className="token-create"><input required minLength="2" placeholder="Token name" value={tokenForm.name} onChange={e => setTokenForm({ ...tokenForm, name: e.target.value })} /><input required type="password" autoComplete="current-password" placeholder="Current password" value={tokenForm.password} onChange={e => setTokenForm({ ...tokenForm, password: e.target.value })} /><label className="settings-switch"><input type="checkbox" checked={tokenForm.operate} onChange={e => setTokenForm({ ...tokenForm, operate: e.target.checked })} /><span><b>Operate nodes</b><small>Allow changes in addition to read access</small></span></label><button disabled={busy === "token"}><Plus /> {busy === "token" ? "Creating…" : "Create token"}</button></form>
          {newToken && <div className="new-api-token"><small>ONLY SHOWN ONCE</small><code>{newToken}<CopyButton value={newToken} label="Copy API token" /></code></div>}
          <div className="security-item-list">{(account.security?.apiTokens || []).map(token => <article key={token.id}><span><b>{token.name}</b><small>{token.hint} · {token.scopes.join(", ")} · {token.lastUsedAt ? `used ${new Date(token.lastUsedAt).toLocaleString("en-GB")}` : "never used"}</small></span><button disabled={busy === token.id} onClick={() => revokeToken(token.id)}><Trash2 /></button></article>)}{!account.security?.apiTokens?.length && <p>No active API tokens.</p>}</div>
        </section>
        <section className="settings-card mcp-settings">
          <header><Bot /><div><h2>AI & MCP access</h2><p>Connect Claude, Codex or another Streamable HTTP MCP client to your Vyron workspace.</p></div><span className="mcp-status"><span /> LIVE</span></header>
          <div className="mcp-permission-grid">
            <article><Eye /><span><b>Read token</b><small>Nodes, live logs and files</small></span></article>
            <article><SquareTerminal /><span><b>Operate nodes</b><small>Start, stop, commands, uploads and edits</small></span></article>
            <article><ShieldCheck /><span><b>Protected actions</b><small>Scoped access with complete audit logs</small></span></article>
          </div>
          <div className="mcp-endpoint"><small>STREAMABLE HTTP ENDPOINT</small><code>{mcpEndpoint}<CopyButton value={mcpEndpoint} label="Copy MCP endpoint" /></code></div>
          <ol className="mcp-steps">
            <li><span>1</span><div><b>Create an API token above</b><p>Enable <strong>Operate nodes</strong> if the AI should change servers, run commands or edit files. The token is only shown once.</p></div></li>
            <li><span>2</span><div><b>Claude Code</b><p>Run this once in your terminal:</p><code>{claudeMcpCommand}<CopyButton value={claudeMcpCommand} label="Copy Claude command" /></code></div></li>
            <li><span>3</span><div><b>Codex</b><p>Set <code>VYRON_MCP_TOKEN</code> in your environment, then add this to <code>~/.codex/config.toml</code>:</p><code>{codexMcpConfig}<CopyButton value={codexMcpConfig} label="Copy Codex configuration" /></code></div></li>
          </ol>
          <footer className="mcp-note"><LockKeyhole /> Your password is never shared. Revoke the API token at any time to disconnect every MCP client using it.</footer>
        </section>
        <section className="settings-card session-settings">
          <header><ShieldCheck /><div><h2>Active sessions</h2><p>Review browsers currently signed into your account.</p></div></header>
          <div className="security-item-list">{(account.security?.sessions || []).map(session => <article key={session.id}><span><b>{session.current ? "This browser" : "Browser session"}</b><small>{session.ip || "Unknown IP"} · {session.lastUsedAt ? new Date(session.lastUsedAt).toLocaleString("en-GB") : "Recently"}</small></span><button disabled={busy === session.id} onClick={() => revokeSession(session)}>{session.current ? <LogOut /> : <Trash2 />}</button></article>)}</div>
        </section>
        <section className="settings-card notification-settings">
          <header><Network /><div><h2>Discord webhook</h2><p>Status changes, deployment results and usage warnings in your server.</p></div></header>
          {account.security?.discord?.connected ? <><div className="settings-success"><Check /> Connected · {account.security.discord.hint}</div><button className="secondary" disabled={busy === "discord"} onClick={disconnectDiscord}>Disconnect webhook</button></> : <form onSubmit={connectDiscord}><label>Discord webhook URL<input required type="url" value={discordWebhook} onChange={(e) => setDiscordWebhook(e.target.value)} placeholder="https://discord.com/api/webhooks/…" /></label><small>Create it in Discord under Channel settings → Integrations → Webhooks. The URL is encrypted and never returned.</small><button disabled={busy === "discord"}><Send /> {busy === "discord" ? "Testing…" : "Connect & send test"}</button></form>}
        </section>
        <section className="settings-card two-factor-settings">
          <header><ShieldCheck /><div><h2>Two-factor authentication</h2><p>Protect login with an authenticator app and recovery codes.</p></div></header>
          {twoFactor.backupCodes.length > 0 && <div className="new-api-token"><small>SAVE THESE RECOVERY CODES NOW</small><code>{twoFactor.backupCodes.join("\n")}<CopyButton value={twoFactor.backupCodes.join("\n")} label="Copy recovery codes" /></code></div>}
          {!account.security?.twoFactor?.enabled && !twoFactor.setup && <form onSubmit={setupTwoFactor}><label>Current password<input required type="password" autoComplete="current-password" value={twoFactor.password} onChange={(e) => setTwoFactor({ ...twoFactor, password: e.target.value })} /></label><button disabled={busy === "2fa"}>Set up 2FA</button></form>}
          {twoFactor.setup && <div className="two-factor-setup"><p>Add this secret to your authenticator app:</p><code>{twoFactor.setup.secret}<CopyButton value={twoFactor.setup.secret} label="Copy secret" /></code><label>6-digit code<input required inputMode="numeric" value={twoFactor.code} onChange={(e) => setTwoFactor({ ...twoFactor, code: e.target.value })} /></label><button disabled={busy === "2fa"} onClick={enableTwoFactor}>Verify & enable</button></div>}
          {account.security?.twoFactor?.enabled && <form onSubmit={disableTwoFactor}><p><Check /> Enabled · {account.security.twoFactor.backupCodesRemaining} recovery codes remaining</p><label>Current password<input required type="password" value={twoFactor.password} onChange={(e) => setTwoFactor({ ...twoFactor, password: e.target.value })} /></label><label>Authentication or recovery code<input required value={twoFactor.code} onChange={(e) => setTwoFactor({ ...twoFactor, code: e.target.value })} /></label><button className="secondary" disabled={busy === "2fa"}>Disable 2FA</button></form>}
        </section>
        <section className="settings-card support-settings">
          <header><CircleHelp /><div><h2>Support tickets</h2><p>Contact Vyron support and keep the conversation attached to your workspace.</p></div></header>
          <form onSubmit={createTicket}><input required minLength="3" placeholder="Subject" value={support.subject} onChange={(e) => setSupport({ ...support, subject: e.target.value })} /><div className="support-row"><select value={support.priority} onChange={(e) => setSupport({ ...support, priority: e.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select><select value={support.vmId} onChange={(e) => setSupport({ ...support, vmId: e.target.value })}><option value="">General question</option>{account.vms.map((vm) => <option value={vm.id} key={vm.id}>{vm.name}</option>)}</select></div><textarea required minLength="10" maxLength="4000" placeholder="Describe what happened…" value={support.message} onChange={(e) => setSupport({ ...support, message: e.target.value })} /><button disabled={busy === "support"}><Send /> Create ticket</button></form>
          <div className="security-item-list">{support.tickets.slice(0, 5).map((ticket) => <article key={ticket.id}><span><b>{ticket.subject}</b><small>{ticket.priority} · {ticket.status} · {new Date(ticket.createdAt).toLocaleString("en-GB")}</small></span></article>)}{!support.tickets.length && <p>No support tickets yet.</p>}</div>
        </section>
        <section className="settings-card referral-settings">
          <header><Users /><div><h2>Referrals</h2><p>Invite friends. You earn €1 after their first successful paid order.</p></div></header>
          {referrals && <><code>{referrals.link}<CopyButton value={referrals.link} label="Copy referral link" /></code><dl><div><dt>Reward balance</dt><dd>€{Number(referrals.creditBalance || 0).toFixed(2)}</dd></div><div><dt>Successful referrals</dt><dd>{referrals.referrals.filter((item) => item.status === "rewarded").length}</dd></div></dl></>}
        </section>
        <section className="settings-card audit-settings">
          <header><Activity /><div><h2>Audit log</h2><p>Security-relevant changes made in this workspace.</p></div></header>
          <div className="security-item-list">{(account.auditLogs || []).slice(0, 8).map((entry) => <article key={entry.id}><span><b>{entry.action.replaceAll(".", " ")}</b><small>{entry.email || "System"} · {entry.target || "workspace"} · {new Date(entry.at).toLocaleString("en-GB")}</small></span></article>)}{!account.auditLogs?.length && <p>No audit events yet.</p>}</div>
        </section>
        <section className="settings-card account-facts">
          <header>
            <ShieldCheck />
            <div>
              <h2>Account</h2>
              <p>Security and infrastructure details.</p>
            </div>
          </header>
          <dl>
            <div>
              <dt>Account ID</dt>
              <dd>{account.user.id.slice(0, 8)}</dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>
                {new Date(account.user.createdAt).toLocaleDateString("en-GB")}
              </dd>
            </div>
            <div>
              <dt>Region</dt>
              <dd>EU Central</dd>
            </div>
            <div>
              <dt>Infrastructure</dt>
              <dd>Vyron Servers · EU Central</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>Secure HTTP-only cookie</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}

function WorkspacePage({ title, copy, icon: Icon }) {
  return (
    <div>
      <div className="vh-title">
        <div>
          <small>VYRON CLOUD</small>
          <h1>{title}</h1>
          <p>{copy}</p>
        </div>
      </div>
      <section className="vh-panel vh-helper">
        <Icon />
        <h2>{title}</h2>
        <p>This area is ready for the next infrastructure extension.</p>
      </section>
    </div>
  );
}

function NetworkPage({ account, openVm }) {
  const nodes = (account.vms || []).filter((node) => node.status !== "deleted");
  return (
    <div className="network-page">
      <div className="vh-title">
        <div>
          <small>YOUR CONNECTIONS</small>
          <h1>Network</h1>
          <p>Manage website, SSH and TCP connections securely from anywhere.</p>
        </div>
      </div>
      <section className="network-hero active">
        <div className="network-orbit"><span><Network /></span><i /><i /><i /></div>
        <div className="network-hero-copy">
          <small>AVAILABLE WORLDWIDE</small>
          <h2>Everything you need to manage your nodes remotely.</h2>
          <p>Use the browser terminal, edit files or open your website. Vyron handles the connection and security automatically.</p>
          <div className="network-route-line">
            <span><i /> Secure remote access</span>
            <span className="network-simple-badge"><ShieldCheck /> No setup required</span>
          </div>
        </div>
      </section>
      <div className="network-grid">
        <section className="vh-panel network-nodes">
          <header><div><h2>Your nodes</h2><p>Choose what you want to open</p></div><span>{nodes.length} nodes</span></header>
          {nodes.length ? nodes.map((node) => {
            const serviceDomain = node.customDomains?.find((item) => item.status === "active")?.domain || node.domain;
            const website = ["node", "nginx"].includes(node.template) ? `https://${serviceDomain}` : null;
            return <article key={node.id} className="network-customer-node">
              <button className="network-node-main" onClick={() => openVm(node.id)}>
                <span className="network-node-icon"><Server /></span>
                <span><b>{node.name}</b><small>{node.template} · {node.plan}</small></span>
              </button>
              <span className={`network-node-state ${node.status}`}><i />{nodeStatusLabel(node.status)}</span>
              <div className="network-customer-actions">
                {website && <a href={website} target="_blank" rel="noreferrer"><Globe2 /> Open website</a>}
                {node.remoteAccess && <button onClick={() => navigator.clipboard.writeText(`ssh${node.remoteAccess.sshPort !== 22 ? ` -p ${node.remoteAccess.sshPort}` : ""} ${node.remoteAccess.username}@${node.remoteAccess.address}`)}><Copy /> Copy SSH command</button>}
                <button onClick={() => openVm(node.id)}><Folder /> Files</button>
              </div>
              {website && <code className="network-public-domain">{serviceDomain}<CopyButton value={serviceDomain} label="Copy domain" /></code>}
              {node.remoteAccess && <div className="network-remote-access"><span>SSH & TCP</span><code>{`ssh${node.remoteAccess.sshPort !== 22 ? ` -p ${node.remoteAccess.sshPort}` : ""} ${node.remoteAccess.username}@${node.remoteAccess.address}`}<CopyButton value={`ssh${node.remoteAccess.sshPort !== 22 ? ` -p ${node.remoteAccess.sshPort}` : ""} ${node.remoteAccess.username}@${node.remoteAccess.address}`} label="Copy SSH command" /></code><small>Use the public SSH command above. No private network address is shown.</small></div>}
            </article>;
          }) : <div className="vh-empty"><Network /><h3>No nodes in this workspace</h3><p>Create your first node and its connections will appear here.</p></div>}
        </section>
        <aside className="network-side">
          <section className="vh-panel">
            <header><div><h2>Ways to connect</h2><p>Built into your dashboard</p></div><Zap /></header>
            <ol><li><b>Website</b><span>Open a deployed website using its Vyron domain.</span></li><li><b>SSH</b><span>Copy the SSH command and connect from your computer.</span></li><li><b>TCP services</b><span>Reach enabled application ports through the secure network.</span></li></ol>
          </section>
          <section className="vh-panel network-security">
            <header><div><h2>Protection</h2><p>Managed automatically</p></div><KeyRound /></header>
            <div><span>Dashboard access</span><b>Account protected</b></div><div><span>SSH connection</span><b>Encrypted</b></div><div><span>TCP routing</span><b>Protected</b></div><div><span>Connection status</span><b>Monitored</b></div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function DeploymentsPage({ vms, openVm }) {
  const nodes = vms.filter((node) => node.status !== "deleted");
  return (
    <div>
      <div className="vh-title">
        <div>
          <small>DELIVERY</small>
          <h1>Deployments</h1>
          <p>Uploaded projects and runtime installation status.</p>
        </div>
      </div>
      <section className="vh-panel node-service-list">
        <header>
          <div>
            <h2>Project deployments</h2>
            <p>
              ZIP projects are installed automatically after node provisioning.
            </p>
          </div>
        </header>
        {nodes.filter((node) => node.deployment).length ? (
          nodes
            .filter((node) => node.deployment)
            .map((node) => (
              <button key={node.id} onClick={() => openVm(node.id)}>
                <FileArchive />
                <span>
                  <b>{node.deployment.fileName}</b>
                  <small>
                    {node.name} · {node.template}
                  </small>
                </span>
                <em className={node.deployment.status}>
                  {node.deployment.status}
                </em>
                <ChevronRight />
              </button>
            ))
        ) : (
          <div className="vh-empty">
            <FileArchive />
            <h3>No project deployments yet</h3>
            <p>Create a Node.js or Nginx node and upload its ZIP project.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function DomainsPage({ vms, domains = [], openVm, refresh }) {
  const nodes = vms.filter((node) => node.status !== "deleted");
  const webNodes = nodes.filter((node) => ["node", "nginx"].includes(node.template));
  const [domain, setDomain] = useState(""), [provider, setProvider] = useState("manual"), [busy, setBusy] = useState(false), [verifying, setVerifying] = useState(""), [error, setError] = useState("");
  const [targetVmId, setTargetVmId] = useState(() => webNodes[0]?.id || ""), [targetWebsiteSlot, setTargetWebsiteSlot] = useState("");
  const [dnsProvider, setDnsProvider] = useState({ cloudflare: { connected: false } }), [providerModal, setProviderModal] = useState(false), [providerToken, setProviderToken] = useState(""), [providerBusy, setProviderBusy] = useState(false);
  const [autoDnsPending, setAutoDnsPending] = useState(null);
  const targetNode = webNodes.find((node) => node.id === targetVmId);
  useEffect(() => { if (!targetVmId && webNodes[0]) setTargetVmId(webNodes[0].id); }, [webNodes.map((node) => node.id).join(",")]);
  useEffect(() => { api("/v1/dns-providers").then(setDnsProvider).catch(() => null); }, []);
  const createDomain = async (selectedProvider = provider) => {
    if (!domain) return;
    setBusy(true); setError("");
    try { await api("/v1/domains", { method: "POST", body: JSON.stringify({ domain, provider: selectedProvider, vmId: targetVmId || null, websiteSlot: targetWebsiteSlot || null }) }); setDomain(""); setProvider("manual"); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const addDomain = async (event) => {
    event.preventDefault();
    if (!domain) return;
    if (provider === "cloudflare" && !dnsProvider.cloudflare?.connected) {
      setAutoDnsPending(null);
      setProviderModal(true);
      return;
    }
    await createDomain(provider);
  };
  const connectCloudflare = async (event) => {
    event.preventDefault(); setProviderBusy(true); setError("");
    try {
      const result = await api("/v1/dns-providers/cloudflare/connect", { method: "POST", body: JSON.stringify({ domain, apiToken: providerToken }) });
      setDnsProvider(result); setProviderToken(""); setProviderModal(false);
      if (autoDnsPending) { await api(`/v1/domains/${autoDnsPending}/enable-cloudflare`, { method: "POST" }); setAutoDnsPending(null); setDomain(""); await refresh(); }
      else await createDomain("cloudflare");
    } catch (e) { setError(e.message); }
    finally { setProviderBusy(false); }
  };
  const disconnectCloudflare = async () => { if (!await siteConfirm({ title: "Disconnect Cloudflare?", message: "Automatic DNS changes will be disabled for this workspace.", confirmLabel: "Disconnect", danger: true })) return; try { setDnsProvider(await api("/v1/dns-providers/cloudflare", { method: "DELETE" })); } catch (e) { setError(e.message); } };
  const enableAutoDns = async (item) => {
    setError(""); setDomain(item.domain); setAutoDnsPending(item.id);
    if (!dnsProvider.cloudflare?.connected) return setProviderModal(true);
    try { setBusy(true); await api(`/v1/domains/${item.id}/enable-cloudflare`, { method: "POST" }); setAutoDnsPending(null); setDomain(""); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const verifyDomain = async (id) => { setVerifying(id); setError(""); try { await api(`/v1/domains/${id}/verify`, { method: "POST" }); await refresh() } catch (e) { setError(e.message) } finally { setVerifying("") } };
  const removeDomain = async (id) => { if (!await siteConfirm({ title: "Remove custom domain?", message: "Vyron will stop routing this domain to your node.", confirmLabel: "Remove domain", danger: true })) return; try { await api(`/v1/domains/${id}`, { method: "DELETE" }); await refresh() } catch (e) { setError(e.message) } };
  const managedPending = domains.filter((item) => item.dnsManaged && !item.verifiedAt).map((item) => item.id).join(",");
  useEffect(() => {
    if (!managedPending) return;
    let active = true;
    const check = async () => {
      await Promise.all(managedPending.split(",").map((id) => api(`/v1/domains/${id}/verify`, { method: "POST" }).catch(() => null)));
      if (active) await refresh();
    };
    const timer = setInterval(check, 5000);
    check();
    return () => { active = false; clearInterval(timer); };
  }, [managedPending]);
  return (
    <div>
      <div className="vh-title">
        <div>
          <small>EDGE</small>
          <h1>Domains</h1>
          <p>Add a domain once. Vyron assigns it automatically after verification.</p>
        </div>
      </div>
      <section className="vh-panel node-service-list">
        <header>
          <div>
            <h2>Service hostnames</h2>
            <p>Reserved hostnames assigned to your nodes.</p>
          </div>
        </header>
        {nodes.length ? (
          nodes.map((node) => {
            const address = node.domain;
            return (
              <button key={node.id} onClick={() => openVm(node.id)}>
                <Globe2 />
                <span>
                  <b>{address}</b>
                  <small>
                    {node.name} · HTTPS web
                  </small>
                </span>
                <em className={node.route?.status || "reserved"}>
                  {node.route?.status || "reserved"}
                </em>
                <ChevronRight />
              </button>
            );
          })
        ) : (
          <div className="vh-empty">
            <Globe2 />
            <h3>No domains yet</h3>
            <p>Your first node hostname will appear here.</p>
          </div>
        )}
      </section>
      <section className="vh-panel domain-connect-panel">
        <header><div><h2>Add a custom domain</h2><p>Choose the destination now. As soon as ownership is verified, routing and SSL are connected automatically.</p></div><Globe2 /></header>
        <form onSubmit={addDomain} className="domain-connect-form domain-auto-assign"><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="www.example.com"/><select value={targetVmId} onChange={(event) => { setTargetVmId(event.target.value); setTargetWebsiteSlot(""); }}><option value="">Verify only · assign later</option>{webNodes.map((node) => <option value={node.id} key={node.id}>{node.name} · {node.template}</option>)}</select><select value={targetWebsiteSlot} onChange={(event) => setTargetWebsiteSlot(event.target.value)} disabled={!targetNode || targetNode.template !== "node"}><option value="">Main website · /</option>{(targetNode?.websites || []).map((site) => <option value={site.slot} key={site.slot}>Website {site.slot} · /{site.slot}</option>)}</select><select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="manual">Manual DNS</option><option value="cloudflare">Cloudflare Auto DNS</option></select><button type="submit" className="domain-add-button" disabled={busy || !domain}>{busy ? "Adding…" : "Add domain"}</button></form>
        {error && <div className="vh-error">{error}</div>}
        {domains.length > 0 && <div className="custom-domain-list dns-domain-list">{domains.map((item) => {
          const assigned = vms.find((node) => node.id === item.vmId);
          const ownership = item.dnsRecords?.find((record) => record.purpose === "ownership") || { type: "TXT", name: `_vyron-verification.${item.domain}`, value: `vyron-verification=${item.verificationToken}` };
          const route = item.dnsRecords?.find((record) => record.purpose === "routing") || { type: "CNAME", name: item.domain, value: item.cnameTarget || "customers.vyronhosting.com" };
          const pendingNode = vms.find((node) => node.id === item.pendingVmId);
          return <article key={item.id} className="dns-domain-card"><div className="dns-domain-head"><Globe2 /><span><b>{item.domain}</b><small>{assigned ? `Connected to ${assigned.name}${item.websiteSlot ? ` · /${item.websiteSlot}` : " · main website"}` : pendingNode ? `Will connect automatically to ${pendingNode.name}${item.pendingWebsiteSlot ? ` · /${item.pendingWebsiteSlot}` : " · main website"}` : item.verifiedAt ? "Verified · not assigned" : item.dnsManaged ? "Vyron is configuring DNS and SSL automatically" : "Manual verification required"}</small></span>{!item.dnsManaged && <button type="button" className="domain-auto-button" disabled={busy} onClick={() => enableAutoDns(item)}><Globe2 /> Configure DNS</button>}<em>{assigned && item.dnsManaged ? "active" : assigned ? "DNS required" : item.verifiedAt ? "verified" : item.dnsManaged ? "configuring" : "unverified"}</em><button onClick={() => removeDomain(item.id)} aria-label="Remove domain"><Trash2 /></button></div>{item.dnsManaged ? <div className={`domain-auto-state ${item.verifiedAt ? "ready" : "working"}`}>{item.verifiedAt ? <Check /> : <LoaderCircle className="spin" />}<span><b>{item.verifiedAt ? "Automatically configured" : "Setting everything up"}</b><small>{item.verifiedAt ? "DNS, SSL and routing are managed by Vyron. No records need to be copied." : "Cloudflare validation runs in the background. You can leave this page."}</small></span></div> : !item.verifiedAt ? <div className="dns-records manual-domain-records"><strong>Manual DNS</strong><p>Add this verification record at your DNS provider. The selected node is connected automatically after verification.</p><label><span>Type</span><code>{ownership.type}</code></label><label><span>Name</span><code>{ownership.name}<CopyButton value={ownership.name} label="Copy validation name" /></code></label><label><span>Value</span><code>{ownership.value}<CopyButton value={ownership.value} label="Copy validation value" /></code></label><button className="verify-dns" disabled={verifying === item.id} onClick={() => verifyDomain(item.id)}><RefreshCw />{verifying === item.id ? "Checking…" : "Check & connect"}</button></div> : assigned ? <div className="dns-records cname"><p>The node is assigned, but DNS access is not authorized yet. Click <b>Configure DNS</b>, or add this routing record manually:</p><label><span>Type</span><code>{route.type}</code></label><label><span>Name</span><code>{route.name}<CopyButton value={route.name} label="Copy CNAME name" /></code></label><label><span>Target</span><code>{route.value}<CopyButton value={route.value} label="Copy CNAME target" /></code></label></div> : <div className="dns-next-step"><Check /> Ownership verified. This domain was added without an automatic destination.</div>}</article>
        })}</div>}
      </section>
      {providerModal && <div className="cloudflare-connect-overlay" role="dialog" aria-modal="true"><form className="cloudflare-connect-modal" onSubmit={connectCloudflare}><button type="button" className="modal-close" onClick={() => { setProviderModal(false); setAutoDnsPending(null); }} aria-label="Close"><X /></button><div className="modal-icon"><Globe2 /></div><small>DNS PROVIDER · CLOUDFLARE</small><h2>Connect Cloudflare</h2><p>Vyron will verify your token, find the zone for <b>{domain || "your domain"}</b>, and create the ownership, certificate and routing records automatically.</p><label>Cloudflare API Token<input autoFocus type="password" value={providerToken} onChange={(e) => setProviderToken(e.target.value)} placeholder="Paste your scoped API token" required /></label><div className="token-permissions"><Check /> Zone:Read <Check /> DNS:Edit</div><small className="modal-note">The token is encrypted before it is stored and is never shown again. Global API keys are not accepted.</small><footer><button type="button" onClick={() => { setProviderModal(false); setAutoDnsPending(null); }}>Cancel</button><button type="submit" disabled={providerBusy || !providerToken}>{providerBusy ? "Verifying…" : "Verify & configure"}</button></footer></form></div>}
    </div>
  );
}

function AdminPanel() {
  const [data, setData] = useState(null),
    [aiConfig, setAiConfig] = useState({ provider: "openrouter", configured: false, endpoint: "https://openrouter.ai/api/v1", model: "openrouter/free", webSearch: true, keyHint: "" }),
    [alertConfig, setAlertConfig] = useState({ configured: false, recipient: "", from: "", trafficThresholdMbps: 500, trafficWindowSamples: 2, cooldownMinutes: 30, keyHint: "" }),
    [stripeConfig, setStripeConfig] = useState({ mode: "test", configured: false, webhookConfigured: false, publishableKeyHint: "" }),
    [statusConfig, setStatusConfig] = useState(null),
    [editingMap, setEditingMap] = useState(false),
    [savingStatus, setSavingStatus] = useState(false),
    [statusSaved, setStatusSaved] = useState(""),
    [statusMapView, setStatusMapView] = useState({ scale: 1, x: 0, y: 0 }),
    [aiKey, setAiKey] = useState(""),
    [alertKey, setAlertKey] = useState(""),
    [savingAi, setSavingAi] = useState(false),
    [savingAlerts, setSavingAlerts] = useState(false),
    [error, setError] = useState(""),
    [command, setCommand] = useState("uptime"),
    [running, setRunning] = useState(false),
    [deleting, setDeleting] = useState(""),
    [banning, setBanning] = useState(""),
    [approving, setApproving] = useState(""),
    [terminal, setTerminal] = useState([
      { type: "system", text: "Vyron secure infrastructure console" },
    ]);
  const statusBackup = useRef(null);
  const statusMapPan = useRef(null);
  const load = async () => {
    try {
      const [overview, gateway, alerts, stripeStatus] = await Promise.all([api("/v1/admin/overview"), api("/v1/admin/ai-config"), api("/v1/admin/alert-config"), api("/v1/admin/stripe-config")]);
      setData(overview); setAiConfig(gateway); setAlertConfig(alerts); setStripeConfig(stripeStatus);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  };
  const toggleCoupon = async (user) => {
    setError("");
    try {
      await api(`/v1/admin/coupons/FREE26/users/${user.id}`, { method: "PUT", body: JSON.stringify({ enabled: !user.free26Enabled }) });
      setData(current => current ? { ...current, users: current.users.map(item => item.id === user.id ? { ...item, free26Enabled: !user.free26Enabled } : item) } : current);
    } catch (e) { setError(e.message); }
  };
  const saveAlertSettings = async (event) => {
    event.preventDefault(); setSavingAlerts(true); setError("");
    try {
      const result = await api("/v1/admin/alert-config", { method: "PUT", body: JSON.stringify({ ...alertConfig, apiKey: alertKey }) });
      setAlertConfig(result); setAlertKey("");
    } catch (e) { setError(e.message); } finally { setSavingAlerts(false); }
  };
  const saveAiGateway = async (e) => {
    e.preventDefault(); setSavingAi(true); setError("");
    try {
      const result = await api("/v1/admin/ai-config", { method: "PUT", body: JSON.stringify({ model: aiConfig.model, apiKey: aiKey, webSearch: aiConfig.webSearch }) });
      setAiConfig(result); setAiKey("");
    } catch (e) { setError(e.message); } finally { setSavingAi(false); }
  };
  useEffect(() => {
    load();
    api("/v1/admin/status-config").then(setStatusConfig).catch((e) => setError(e.message));
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  const beginStatusEdit = () => {
    statusBackup.current = JSON.parse(JSON.stringify(statusConfig));
    setStatusSaved("");
    setEditingMap(true);
  };
  const cancelStatusEdit = () => {
    if (statusBackup.current) setStatusConfig(statusBackup.current);
    setEditingMap(false);
    setStatusSaved("");
  };
  const saveStatusConfig = async () => {
    if (!statusConfig || savingStatus) return;
    setSavingStatus(true); setError(""); setStatusSaved("");
    try {
      const result = await api("/v1/admin/status-config", { method: "PUT", body: JSON.stringify({ locations: statusConfig.locations }) });
      setStatusConfig(result); setEditingMap(false); setStatusSaved("Saved and published"); statusBackup.current = null;
    } catch (e) { setError(e.message); } finally { setSavingStatus(false); }
  };
  const updateLocation = (id, patch) => setStatusConfig(current => ({ ...current, locations: current.locations.map(location => location.id === id ? { ...location, ...patch } : location) }));
  const dragStatusLocation = (event, id) => {
    if (!editingMap) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = event.currentTarget.parentElement.getBoundingClientRect();
    const move = (pointer) => updateLocation(id, { x: Math.max(0, Math.min(100, (pointer.clientX - bounds.left) / bounds.width * 100)), y: Math.max(0, Math.min(100, (pointer.clientY - bounds.top) / bounds.height * 100)) });
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    move(event); window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true });
  };
  const zoomStatusMap = (amount) => setStatusMapView(current => ({ ...current, scale: Math.max(1, Math.min(3.5, +(current.scale + amount).toFixed(2))) }));
  const panStatusMap = (event) => {
    if (event.target.closest(".admin-map-marker") || event.target.closest(".admin-status-map-controls")) return;
    event.preventDefault();
    const start = { clientX: event.clientX, clientY: event.clientY, x: statusMapView.x, y: statusMapView.y };
    statusMapPan.current = start;
    const move = (pointer) => setStatusMapView(current => ({ ...current, x: start.x + pointer.clientX - start.clientX, y: start.y + pointer.clientY - start.clientY }));
    const stop = () => { statusMapPan.current = null; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true });
  };
  const execute = async (e) => {
    e.preventDefault();
    const next = command.trim();
    if (!next || running) return;
    setTerminal((items) => [...items, { type: "command", text: `$ ${next}` }]);
    setCommand("");
    setRunning(true);
    try {
      const result = await api("/v1/admin/terminal", {
        method: "POST",
        body: JSON.stringify({ command: next }),
      });
      setTerminal((items) => [
        ...items,
        {
          type: result.stderr ? "error" : "output",
          text: `${result.stdout || ""}${result.stderr || ""}`.trim() ||
            `Command completed with exit code ${result.exitCode}.`,
        },
      ]);
    } catch (e) {
      setTerminal((items) => [...items, { type: "error", text: e.message }]);
    } finally {
      setRunning(false);
    }
  };
  const deleteNode = async (node) => {
    if (deleting || !await confirmNodeDeletion(node.name)) return;
    setDeleting(node.id);
    setError("");
    try {
      await api(`/v1/admin/nodes/${encodeURIComponent(node.id)}`, { method: "DELETE", body: JSON.stringify({ confirmation: `DELETE ${node.name}` }) });
      setData(current => current ? {
        ...current,
        nodes: current.nodes.filter(item => item.id !== node.id),
        stats: { ...current.stats, nodes: Math.max(0, current.stats.nodes - 1), runningNodes: Math.max(0, current.stats.runningNodes - (node.status === "running" ? 1 : 0)) },
      } : current);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleting("");
    }
  };
  const toggleBan = async (item) => {
    if (banning || item.isAdmin) return;
    const nextBanned = !item.banned;
    const action = nextBanned ? "suspend" : "restore";
    if (!await siteConfirm({ title: `${action === "suspend" ? "Suspend" : "Restore"} ${item.email}?`, message: nextBanned ? "All active sessions will be revoked immediately and this account will no longer be able to sign in." : "This account will be allowed to sign in again.", confirmLabel: action === "suspend" ? "Suspend account" : "Restore account", danger: nextBanned })) return;
    setBanning(item.id);
    setError("");
    try {
      const result = await api(`/v1/admin/users/${encodeURIComponent(item.id)}/ban`, {
        method: "PATCH",
        body: JSON.stringify({ banned: nextBanned }),
      });
      setData(current => current ? {
        ...current,
        users: current.users.map(user => user.id === item.id ? { ...user, ...result.user } : user),
      } : current);
    } catch (e) {
      setError(e.message);
    } finally {
      setBanning("");
    }
  };
  const setAccountApproval = async (item, status) => {
    if (approving || item.isAdmin) return;
    if (status === "rejected" && !await siteConfirm({ title: `Reject ${item.email}?`, message: "This account will not be able to sign in. You can approve it later.", confirmLabel: "Reject account", danger: true })) return;
    setApproving(item.id); setError("");
    try {
      const result = await api(`/v1/admin/users/${encodeURIComponent(item.id)}/approval`, { method: "PATCH", body: JSON.stringify({ status }) });
      setData(current => current ? { ...current, users: current.users.map(user => user.id === item.id ? { ...user, ...result.user } : user) } : current);
    } catch (e) { setError(e.message); }
    finally { setApproving(""); }
  };
  const updateSupportTicket = async (ticket, status) => {
    setError("");
    try { const result = await api(`/v1/admin/support/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ status, priority: ticket.priority }) }); setData((current) => ({ ...current, supportTickets: current.supportTickets.map((item) => item.id === ticket.id ? result.ticket : item) })); }
    catch (e) { setError(e.message); }
  };
  const uptime = (seconds = 0) => {
    const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600);
    return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  };
  const metrics = data?.host?.metrics || {};
  const gpu = metrics.gpu || {};
  return (
    <div className="admin-page">
      <div className="vh-title admin-title">
        <div>
          <small>VYRON CONTROL PLANE</small>
          <h1>Admin Panel</h1>
          <p>Live operations, customers and server infrastructure.</p>
        </div>
        <span className={`admin-live ${data?.host?.status === "ok" ? "online" : ""}`}>
          <i /> {data?.host?.status === "ok" ? "Servers online" : "Servers offline"}
        </span>
      </div>
      {error && <div className="vh-error">{error}</div>}
      {!data ? (
        <div className="vh-panel admin-loading">Loading control plane…</div>
      ) : (
        <>
          <div className="admin-kpis">
            <article><span><UserRound /></span><small>ACCOUNTS</small><b>{data.stats.accounts}</b><em>{data.stats.workspaces} workspaces</em></article>
            <article><span><CreditCard /></span><small>REVENUE</small><b>€{data.stats.revenue.toFixed(2)}</b><em>{data.stats.orders} total orders</em></article>
            <article><span><Server /></span><small>ACTIVE NODES</small><b>{data.stats.runningNodes}<i> / {data.stats.nodes}</i></b><em>real hypervisor state</em></article>
            <article><span><Activity /></span><small>SERVER UPTIME</small><b>{uptime(metrics.uptime)}</b><em>EU Central</em></article>
          </div>
          <div className="admin-capacity">
            {[
              ["CPU", `${metrics.cpu ?? 0}%`, `${data.stats.allocated.cpu} vCPU allocated`, metrics.cpu || 0, Cpu],
              ["MEMORY", `${metrics.usedRam ?? 0} GB`, `${metrics.totalRam ?? 0} GB physical · ${data.stats.allocated.ram} GB allocated`, metrics.totalRam ? metrics.usedRam / metrics.totalRam * 100 : 0, Database],
              ["STORAGE", `${metrics.usedStorage ?? 0} GB`, `${metrics.totalStorage ?? 0} GB server capacity · ${data.stats.allocated.disk} GB allocated`, metrics.totalStorage ? metrics.usedStorage / metrics.totalStorage * 100 : 0, HardDrive],
              ["GPU / VRAM", gpu.available ? `${gpu.utilization}%` : "Unavailable", gpu.available ? `${gpu.usedVramMb} / ${gpu.totalVramMb} MB VRAM` : "No NVIDIA GPU detected", gpu.available && gpu.totalVramMb ? gpu.usedVramMb / gpu.totalVramMb * 100 : 0, Zap],
            ].map(([label, value, detail, percent, Icon]) => (
              <article key={label}>
                <header><Icon /><span><small>{label}</small><b>{value}</b></span></header>
                <div><i style={{ width: `${Math.min(100, percent)}%` }} /></div>
                <p>{detail}</p>
              </article>
            ))}
          </div>
          {statusConfig && <section className={`vh-panel admin-status-editor ${editingMap ? "editing" : "locked"}`}>
            <header>
              <div><h2><Globe2 /> Public status map</h2><p>Persistent server locations and service state shown on status.vyronpanel.com</p></div>
              <div className="admin-status-actions">
                {statusSaved && <span className="admin-status-saved"><Check />{statusSaved}</span>}
                {!editingMap ? <button type="button" className="admin-status-edit" onClick={beginStatusEdit}><Pencil />Edit map</button> : <><button type="button" className="admin-status-cancel" onClick={cancelStatusEdit}>Cancel</button><button type="button" className="admin-status-save" disabled={savingStatus} onClick={saveStatusConfig}><Save />{savingStatus ? "Saving…" : "Save & publish"}</button></>}
              </div>
            </header>
            <div className="admin-status-layout">
              <div className="admin-status-map" onPointerDown={panStatusMap} onWheel={(event) => { event.preventDefault(); zoomStatusMap(event.deltaY < 0 ? .2 : -.2); }}>
                <div className="admin-status-map-layer" style={{ transform: `translate(${statusMapView.x}px, ${statusMapView.y}px) scale(${statusMapView.scale})` }}>
                  <img src="https://status.vyronpanel.com/world-map.png" alt="World map" draggable="false" />
                  {statusConfig.locations.map(location => <button key={location.id} type="button" className={`admin-map-marker ${location.status}`} style={{ left: `${location.x}%`, top: `${location.y}%` }} onPointerDown={(event) => dragStatusLocation(event, location.id)} title={editingMap ? `Drag ${location.name}` : `${location.name} · ${location.status}`}><MapPin /></button>)}
                </div>
                <span className="admin-map-mode">{editingMap ? "Editing enabled · drag a marker, then save" : "Drag to pan · click Edit map to move servers"}</span>
                <nav className="admin-status-map-controls" aria-label="Map zoom controls">
                  <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => zoomStatusMap(-.25)} aria-label="Zoom out">−</button>
                  <span>{Math.round(statusMapView.scale * 100)}%</span>
                  <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => zoomStatusMap(.25)} aria-label="Zoom in">+</button>
                  <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => setStatusMapView({ scale: 1, x: 0, y: 0 })} aria-label="Reset map"><RefreshCw /></button>
                </nav>
              </div>
              <div className="admin-location-list">
                {statusConfig.locations.map(location => <article key={location.id}>
                  <span className={`admin-location-state ${location.status}`}><i /></span>
                  <div className="admin-location-fields">
                    {editingMap ? <><label>Name<input value={location.name} maxLength="80" onChange={(event) => updateLocation(location.id, { name: event.target.value })} /></label><div><label>City<input value={location.city} maxLength="80" onChange={(event) => updateLocation(location.id, { city: event.target.value })} /></label><label>Country<input value={location.country} maxLength="80" onChange={(event) => updateLocation(location.id, { country: event.target.value })} /></label><label>Region<input value={location.region} maxLength="80" onChange={(event) => updateLocation(location.id, { region: event.target.value })} /></label></div></> : <><b>{location.name}</b><small>{location.city}, {location.country} · {location.region}<br />Position {location.x.toFixed(1)}%, {location.y.toFixed(1)}%</small></>}
                  </div>
                  <div className="admin-state-picker"><small>PUBLIC STATE</small><div>{[["operational", "Operational"], ["maintenance", "Maintenance"], ["major", "Major"]].map(([state, label]) => <button type="button" key={state} disabled={!editingMap} className={location.status === state ? `active ${state}` : state} onClick={() => updateLocation(location.id, { status: state })}>{label}</button>)}</div></div>
                </article>)}
                <p><ShieldCheck /> Saved server-side. If the dashboard is unavailable, the last published map and states remain active.</p>
              </div>
            </div>
          </section>}
          <section className="vh-panel admin-paypal-mode sandbox">
            <header><div><h2><CreditCard /> Stripe environment</h2><p>Embedded Checkout is locked to Stripe test mode. No real money can be charged.</p></div><span className="sandbox">TEST MODE</span></header>
            <div className="paypal-mode-picker">
              <button type="button" className="active" disabled><i /><span><b>Stripe Sandbox</b><small>{stripeConfig.configured ? `API keys configured · ${stripeConfig.publishableKeyHint}` : "Add pk_test and sk_test keys on the server"}</small></span>{stripeConfig.configured && <Check />}</button>
              <button type="button" className={stripeConfig.webhookConfigured ? "active" : ""} disabled><i /><span><b>Signed webhook</b><small>{stripeConfig.webhookConfigured ? "Webhook secret configured" : "Add the whsec test signing secret"}</small></span>{stripeConfig.webhookConfigured && <Check />}</button>
            </div>
            <footer><ShieldCheck /> Secret keys cannot be viewed or changed in this panel. Checkout stays embedded and live Stripe keys are rejected by this integration.</footer>
          </section>
          <section className="vh-panel admin-ai-gateway">
            <header><div><h2><Bot /> OpenRouter AI</h2><p>Free model routing and optional web search for Vyron Copilot</p></div><span className={aiConfig.configured ? "configured" : "missing"}>{aiConfig.configured ? "Configured" : "Setup required"}</span></header>
            <form onSubmit={saveAiGateway}>
              <label>Model<input required placeholder="openrouter/free" value={aiConfig.model} onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })} /></label>
              <label>OpenRouter API key<input required={!aiConfig.configured} type="password" autoComplete="new-password" placeholder={aiConfig.keyHint || "sk-or-v1-…"} value={aiKey} onChange={(e) => setAiKey(e.target.value)} /></label>
              <label className="admin-ai-toggle"><span>Web search</span><input type="checkbox" checked={aiConfig.webSearch !== false} onChange={(e) => setAiConfig({ ...aiConfig, webSearch: e.target.checked })} /></label>
              <button disabled={savingAi}><Save />{savingAi ? "Saving…" : "Save OpenRouter"}</button>
            </form>
            <footer><ShieldCheck /> OpenRouter supports the free <code>openrouter/free</code> model. Web search may have separate provider costs. The key stays server-side and node passwords never enter the model.</footer>
          </section>
          <section className="vh-panel admin-ai-gateway security-alert-settings">
            <header><div><h2><Flag /> Security alerts & traffic protection</h2><p>Receive domain reports and high-traffic warnings by email.</p></div><span className={alertConfig.configured ? "configured" : "missing"}>{alertConfig.configured ? "Configured" : "Email setup required"}</span></header>
            <form onSubmit={saveAlertSettings}>
              <label>Resend API key<input type="password" autoComplete="new-password" placeholder={alertConfig.keyHint || "re_…"} value={alertKey} onChange={event => setAlertKey(event.target.value)} /></label>
              <label>Alert recipient<input required type="email" value={alertConfig.recipient} onChange={event => setAlertConfig({ ...alertConfig, recipient: event.target.value })} /></label>
              <label>Verified sender<input required value={alertConfig.from} onChange={event => setAlertConfig({ ...alertConfig, from: event.target.value })} placeholder="Vyron Security <security@vyronhosting.com>" /></label>
              <label>Traffic alert (Mbps)<input type="number" min="10" max="10000" value={alertConfig.trafficThresholdMbps} onChange={event => setAlertConfig({ ...alertConfig, trafficThresholdMbps: Number(event.target.value) })} /></label>
              <button disabled={savingAlerts}><Save />{savingAlerts ? "Saving…" : "Save alerts"}</button>
            </form>
            <footer><ShieldCheck /> Reports are always stored in this panel. Email delivery needs a verified sender in Resend; aggregate traffic alerts are a warning signal, not a DDoS mitigation replacement.</footer>
          </section>
          <section className="vh-panel admin-services">
            <header><div><h2>Platform services</h2><p>PM2 processes, kernel and system load</p></div><span>Load {(data.host.system?.loadAverage || []).join(" · ") || "—"}</span></header>
            <div>
              {(data.host.system?.services || []).map(service => <article key={service.name}><i className={service.status} /><span><b>{service.name}</b><small>{service.memoryMb} MB · {service.cpu}% CPU</small></span><em>{service.status}</em><small>{service.restarts} restarts</small></article>)}
              {!data.host.system?.services?.length && <p>No PM2 service data available.</p>}
            </div>
            <footer>{data.host.system?.platform || "linux"} · kernel {data.host.system?.release || "unknown"} · network transfer {metrics.networkGb || 0} GB</footer>
          </section>
          <div className="admin-main-grid">
            <section className="vh-panel admin-terminal">
              <header><div><h2><SquareTerminal /> Infrastructure terminal</h2><p>Secure administrator console</p></div><span>LIVE SESSION</span></header>
              <div className="admin-terminal-screen">
                {terminal.map((line, index) => <pre className={line.type} key={`${index}-${line.text}`}>{line.text}</pre>)}
                {running && <pre className="system">Running…</pre>}
              </div>
              <div className="admin-presets">
                {["uptime", "free -h", "df -h /", "pm2 status"].map(value => <button key={value} onClick={() => setCommand(value)}>{value}</button>)}
              </div>
              <form onSubmit={execute}><span>admin@vyron:~$</span><input value={command} onChange={e => setCommand(e.target.value)} autoComplete="off" spellCheck="false" placeholder="Enter a server command" /><button disabled={running}><ChevronRight /></button></form>
            </section>
            <section className="vh-panel admin-fleet">
              <header><div><h2>Node fleet</h2><p>Live server state across all accounts</p></div><b>{data.stats.nodes}</b></header>
              <div>{data.nodes.map(node => <article key={node.id}><span className={`admin-node-dot ${node.status}`} /><div><b>{node.name}</b><small>{node.owner?.email || "Unknown owner"}</small></div><em>{node.cpu} CPU · {node.ram} GB</em><strong className={node.status}>{nodeStatusLabel(node.status)}</strong><button type="button" className="admin-delete-node" disabled={Boolean(deleting)} onClick={() => deleteNode(node)} title={`Permanently delete ${node.name}`} aria-label={`Permanently delete ${node.name}`}>{deleting === node.id ? <LoaderCircle className="spin" /> : <Trash2 />}</button></article>)}</div>
            </section>
          </div>
          <section className="vh-panel admin-accounts">
            <header><div><h2>Customer accounts</h2><p>Approve new registrations before they can access Vyron</p></div><span>{data.users.filter(item => item.approvalStatus === "pending").length} awaiting approval · {data.users.filter(item => item.banned).length} suspended · {data.users.length} total</span></header>
            <div className="admin-table">
              <div className="head"><span>Customer</span><span>Access</span><span>FREE26</span><span>Nodes</span><span>Revenue</span><span>Joined</span><span>Action</span></div>
              {data.users.map(item => <div key={item.id} className={item.banned ? "banned-row" : item.approvalStatus === "pending" ? "pending-row" : item.approvalStatus === "rejected" ? "rejected-row" : ""}><span><i>{item.name.slice(0, 2).toUpperCase()}</i><b>{item.name}<small>{item.email}</small></b></span><span><em className={item.banned ? "banned" : item.isAdmin ? "admin" : item.approvalStatus === "pending" ? "pending" : item.approvalStatus === "rejected" ? "rejected" : "customer"}>{item.banned ? "Suspended" : item.isAdmin ? "Admin" : item.approvalStatus === "pending" ? "Pending" : item.approvalStatus === "rejected" ? "Rejected" : "Approved"}</em></span><span><em className="customer">First month · 20%</em></span><span>{item.nodes}</span><span>€{item.spend.toFixed(2)}</span><span>{new Date(item.createdAt).toLocaleDateString("en-GB")}</span><span className="admin-account-actions">{!item.isAdmin && item.approvalStatus !== "approved" && <button type="button" className="admin-approve-user" disabled={Boolean(approving)} onClick={() => setAccountApproval(item, "approved")}>{approving === item.id ? <LoaderCircle className="spin" /> : "Approve"}</button>}{!item.isAdmin && item.approvalStatus === "pending" && <button type="button" className="admin-reject-user" disabled={Boolean(approving)} onClick={() => setAccountApproval(item, "rejected")}>Reject</button>}{(item.isAdmin || item.approvalStatus === "approved") && <button type="button" className={`admin-ban-user ${item.banned ? "restore" : ""}`} disabled={item.isAdmin || Boolean(banning)} onClick={() => toggleBan(item)} title={item.isAdmin ? "Administrator accounts are protected" : item.banned ? "Restore account" : "Suspend account"}>{banning === item.id ? <LoaderCircle className="spin" /> : item.banned ? "Restore" : "Suspend"}</button>}</span></div>)}
            </div>
          </section>
          <section className="vh-panel admin-orders security-reports">
            <header><div><h2><Flag /> Trust & Safety queue</h2><p>Domain reports and automated traffic warnings.</p></div><span>{(data.abuseReports || []).filter(item => item.status === "pending").length} pending</span></header>
            <div>{data.abuseReports?.length ? data.abuseReports.map(report => <article key={report.id}><Flag /><span><b>{report.domain}</b><small>{report.category} · {new Date(report.createdAt).toLocaleString("en-GB")}<br />{report.details}</small></span><select value={report.status} onChange={async event => { try { const result = await api(`/v1/admin/reports/${report.id}`, { method: "PATCH", body: JSON.stringify({ status: event.target.value }) }); setData(current => current ? { ...current, abuseReports: current.abuseReports.map(item => item.id === report.id ? result.report : item) } : current); } catch (e) { setError(e.message); } }}><option value="pending">Pending</option><option value="reviewing">Reviewing</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select></article>) : <p>No domain reports yet.</p>}</div>
          </section>
          <section className="vh-panel admin-orders">
            <header><div><h2>Recent orders</h2><p>Latest billing activity and discounts</p></div><span>{data.orders.length} shown</span></header>
            <div>{data.orders.length ? data.orders.map(order => <article key={order.id}><CreditCard /><span><b>{order.customer}</b><small>{order.plan} · {new Date(order.createdAt).toLocaleString("en-GB")}</small></span><em className={order.status}>{order.status.replaceAll("_", " ")}</em><strong>€{Number(order.total).toFixed(2)}</strong></article>) : <p>No orders yet.</p>}</div>
          </section>
          <section className="vh-panel admin-orders">
            <header><div><h2><CircleHelp /> Support queue</h2><p>Workspace tickets requiring a response.</p></div><span>{(data.supportTickets || []).filter((ticket) => ticket.status === "open").length} open</span></header>
            <div>{data.supportTickets?.length ? data.supportTickets.map((ticket) => <article key={ticket.id}><CircleHelp /><span><b>{ticket.number} · {ticket.subject}</b><small>{ticket.nodeName || "General"} · {ticket.priority} · {new Date(ticket.createdAt).toLocaleString("en-GB")}</small></span><select value={ticket.status} onChange={(event) => updateSupportTicket(ticket, event.target.value)}><option value="open">Open</option><option value="waiting">Waiting</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select></article>) : <p>No support tickets yet.</p>}</div>
          </section>
          <section className="vh-panel admin-orders">
            <header><div><h2><Activity /> Audit log</h2><p>Recent security and infrastructure actions.</p></div><span>{data.auditLogs?.length || 0} events</span></header>
            <div>{data.auditLogs?.length ? data.auditLogs.slice(0, 30).map((entry) => <article key={entry.id}><Activity /><span><b>{entry.action.replaceAll(".", " ")}</b><small>{entry.email || "System"} · {entry.target || "platform"} · {new Date(entry.at).toLocaleString("en-GB")}</small></span></article>) : <p>No audit events yet.</p>}</div>
          </section>
        </>
      )}
    </div>
  );
}

function Dashboard({ user, onLogout }) {
  const routeMatch = window.location.pathname.match(
    /^\/(?:nodes|instances)\/([^/]+)$/,
  );
  const [page, setPage] = useState(routeMatch ? "nodes" : window.location.pathname === "/admin" ? "admin" : "overview"),
    [account, setAccount] = useState({
      user,
      vms: [],
      orders: [],
      workspace: null,
    }),
    [loaded, setLoaded] = useState(false),
    [deploy, setDeploy] = useState(false),
    [selectedId, setSelectedId] = useState(
      routeMatch ? decodeURIComponent(routeMatch[1]) : null,
    ),
    [mobile, setMobile] = useState(false),
    [error, setError] = useState("");
  const refresh = async () => {
    try {
      setAccount(await api("/v1/account"));
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    refresh();
    const query = new URLSearchParams(window.location.search);
    const stripeOrderId = query.get("stripe_order");
    const stripeSessionId = query.get("stripe_session");
    const orderId = query.get("paypal_order");
    const paypalOrderId = query.get("token");
    if (stripeOrderId && stripeSessionId) {
      api("/v1/payments/stripe/confirm", { method: "POST", body: JSON.stringify({ orderId: stripeOrderId, sessionId: stripeSessionId }) })
        .then(() => refresh())
        .catch((paymentError) => setError(paymentError.message))
        .finally(() => history.replaceState({}, "", "/app"));
    } else if (orderId && paypalOrderId) {
      api("/v1/payments/paypal/capture", { method: "POST", body: JSON.stringify({ orderId, paypalOrderId }) })
        .then(() => refresh())
        .catch((paymentError) => setError(paymentError.message))
        .finally(() => history.replaceState({}, "", "/app"));
    } else if (query.get("paypal_cancelled")) {
      setError("PayPal checkout was cancelled. No node was created.");
      history.replaceState({}, "", "/app");
    }
    const timer = setInterval(refresh, 5000);
    const pop = () => {
      const match = window.location.pathname.match(
        /^\/(?:nodes|instances)\/([^/]+)$/,
      );
      setSelectedId(match ? decodeURIComponent(match[1]) : null);
      setPage(
        match || ["/nodes", "/instances"].includes(window.location.pathname)
          ? "nodes"
          : window.location.pathname === "/admin"
            ? "admin"
          : "overview",
      );
    };
    window.addEventListener("popstate", pop);
    return () => {
      clearInterval(timer);
      window.removeEventListener("popstate", pop);
    };
  }, []);
  const nav = [
    ["overview", "Overview", LayoutDashboard],
    ["nodes", "Nodes", Server],
    ["deployments", "Deployments", Box],
    ["helper", "AI Helper", Bot],
    ["domains", "Domains", Globe2],
    ["network", "Network", Network],
  ];
  const manage = [
    ...(account.workspace?.permissions?.manage ? [["billing", "Usage & Billing", Activity]] : []),
    ["settings", "Settings", Settings],
    ...(account.user?.isAdmin ? [["admin", "Admin Panel", ShieldCheck]] : []),
  ];
  const logout = async () => {
    await api("/v1/auth/logout", { method: "POST" }).catch(() => {});
    onLogout();
    history.replaceState({}, "", "/login");
  };
  const activateWorkspace = async (workspaceId) => {
    try {
      await api(`/v1/workspaces/${workspaceId}/activate`, { method: "POST" });
      setSelectedId(null); setPage("overview"); await refresh();
    } catch (e) { setError(e.message); }
  };
  const openVm = (id) => {
    setSelectedId(id);
    setPage("nodes");
    history.pushState({}, "", `/nodes/${encodeURIComponent(id)}`);
  };
  const closeVm = () => {
    setSelectedId(null);
    setPage("nodes");
    history.pushState({}, "", "/nodes");
  };
  const goPage = (id) => {
    setSelectedId(null);
    setPage(id);
    setMobile(false);
    history.pushState({}, "", id === "nodes" ? "/nodes" : id === "admin" ? "/admin" : "/app");
  };
  const monthly = account.orders
    .filter((o) => o.status === "paid")
    .reduce((sum, o) => sum + o.total, 0);
  const selectedVm = account.vms.find((v) => v.id === selectedId);
  const current = selectedVm
    ? selectedVm.name
    : [...nav, ...manage].find((x) => x[0] === page)?.[1] || "Overview";
  if (!loaded)
    return <LoadingScreen />;
  if (!account.workspace)
    return <WorkspaceSetup user={account.user} onCreated={refresh} />;
  return (
    <div className="vh-shell ent-shell">
      <aside className={mobile ? "open" : ""}>
        <header>
          <Brand />
          <button onClick={() => setMobile(false)}>
            <X />
          </button>
        </header>
        <button className="ent-workspace" onClick={() => goPage("settings")}>
          <span>{account.workspace.name.slice(0, 2).toUpperCase()}</span>
          <div>
            <b>{account.workspace.name}</b>
            <small>{account.workspace.slug} · EU Central</small>
          </div>
          <ChevronRight />
        </button>
        {account.workspaces?.length > 1 && <select className="workspace-switcher" value={account.workspace.id} onChange={(e) => activateWorkspace(e.target.value)}>{account.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select>}
        <nav>
          <small>WORKSPACE</small>
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => goPage(id)}
            >
              <Icon />
              {label}
              {id === "helper" && <em>AI</em>}
            </button>
          ))}
          <small>MANAGE</small>
          {manage.map(([id, label, Icon]) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => goPage(id)}
            >
              <Icon />
              {label}
            </button>
          ))}
        </nav>
        <div className="ent-side-bottom">
          <div className="ent-spend">
            <span>
              Monthly usage <b>€{monthly.toFixed(2)}</b>
            </span>
            <i>
              <em
                style={{ width: `${Math.min(100, (monthly / 50) * 100)}%` }}
              />
            </i>
            <small>€{monthly.toFixed(2)} of €50.00</small>
          </div>
          <button>
            <CircleHelp /> Help & documentation <ChevronRight />
          </button>
          <nav className="ent-legal"><a href="/terms" target="_blank">AGB</a><a href="/privacy" target="_blank">Datenschutz</a><a href="https://status.vyronpanel.com" target="_blank" rel="noreferrer">Status</a></nav>
          <footer>
            <span>{account.user.name.slice(0, 2).toUpperCase()}</span>
            <div>
              <b>{account.user.name}</b>
              <small>{account.user.email}</small>
            </div>
            <button onClick={logout}>
              <LogOut />
            </button>
          </footer>
        </div>
      </aside>
      <main>
        <header className="vh-top ent-top">
          <button onClick={() => setMobile(true)}>
            <Menu />
          </button>
          <div>
            <span>Vyron Cloud</span>
            <ChevronRight />
            <b>{current}</b>
          </div>
          <label>
            <Search />
            <input placeholder="Search" />
            <kbd>⌘ K</kbd>
          </label>
          <button className="ent-help">
            <CircleHelp />
          </button>
          <span className="ent-region">
            <i /> EU Central
          </span>
        </header>
        <div className="vh-content ent-content">
          {error && <div className="vh-error">{error}</div>}
          {selectedVm ? (
            <VMDetail vm={selectedVm} domains={account.domains} close={closeVm} refresh={refresh} />
          ) : (
            <>
              {page === "overview" && (
                <Overview
                  account={account}
                  openDeploy={() => setDeploy(true)}
                  setPage={goPage}
                  openVm={openVm}
                  canCreate={account.workspace.permissions?.manage}
                />
              )}{" "}
              {page === "nodes" && (
                <Instances
                  vms={account.vms}
                  refresh={refresh}
                  openVm={openVm}
                  openDeploy={() => setDeploy(true)}
                  canCreate={account.workspace.permissions?.manage}
                />
              )}{" "}
              {page === "billing" && <Billing orders={account.orders} />}{" "}
              {page === "helper" && <Helper />}{" "}
              {page === "deployments" && (
                <DeploymentsPage vms={account.vms} openVm={openVm} />
              )}{" "}
              {page === "domains" && (
                <DomainsPage vms={account.vms} domains={account.domains} openVm={openVm} refresh={refresh} />
              )}{" "}
              {page === "network" && (
                <NetworkPage account={account} openVm={openVm} />
              )}{" "}
              {page === "settings" && (
                <AccountSettings account={account} refresh={refresh} />
              )}
              {page === "admin" && account.user.isAdmin && <AdminPanel />}
            </>
          )}
        </div>
      </main>
      {deploy && (
        <Deploy
          account={account}
          close={() => {
            setDeploy(false);
            refresh();
          }}
          onCreated={() => refresh()}
        />
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true);
  const path = window.location.pathname;
  const legalType = ["/terms", "/agb"].includes(path) ? "terms" : ["/privacy", "/datenschutz"].includes(path) ? "privacy" : null;
  const appHost =
    window.location.hostname.startsWith("app.") ||
    window.location.port === "3002";
  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
    localStorage.setItem("vyron-theme", "dark");
    if (legalType || path === "/report" || (!appHost && (path === "/" || path === ""))) {
      setLoading(false);
      return;
    }
    api("/v1/auth/me")
      .then((x) => setUser(x.user))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  if (legalType) return <LegalPage type={legalType} />;
  if (path === "/report") return <ReportDomainPage />;
  if (!appHost && (path === "/" || path === "")) return <LandingPage />;
  if (loading)
    return <LoadingScreen />;
  if (path === "/register")
    return user ? (
      <Dashboard user={user} onLogout={() => setUser(null)} />
    ) : (
      <Auth mode="register" onAuth={setUser} />
    );
  if (path === "/login")
    return user ? (
      <Dashboard user={user} onLogout={() => setUser(null)} />
    ) : (
      <Auth mode="login" onAuth={setUser} />
    );
  return user ? (
    <Dashboard user={user} onLogout={() => setUser(null)} />
  ) : (
    <Auth mode="login" onAuth={setUser} />
  );
}
