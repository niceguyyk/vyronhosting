import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Cloud,
  Code2,
  Cpu,
  Database,
  Gauge,
  Globe2,
  Menu,
  Server,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";

const offers = [
  {
    name: "Mini",
    price: "1.00",
    copy: "For bots and small experiments",
    items: ["0.5 vCPU", "2 GB RAM", "20 GB NVMe"],
  },
  {
    name: "Basic",
    price: "5.00",
    copy: "For websites and APIs",
    items: ["1 vCPU", "4 GB RAM", "100 GB NVMe"],
    popular: true,
  },
  {
    name: "Pro",
    price: "10.00",
    copy: "For serious workloads",
    items: ["2 vCPU", "6 GB RAM", "200 GB NVMe"],
  },
  {
    name: "Enterprise",
    price: "20.00",
    copy: "Maximum local performance",
    items: ["4 vCPU", "12 GB RAM", "500 GB NVMe"],
  },
];

function Brand() {
  return (
    <a className="land-brand" href="/">
      <span>
        <i />
      </span>
      <strong>vyron</strong>
    </a>
  );
}

export default function LandingPage() {
  const [menu, setMenu] = useState(false);
  const appBase = window.location.hostname.endsWith("vyronhosting.com")
    ? "https://app.vyronhosting.com"
    : "";

  useEffect(() => {
    const items = document.querySelectorAll("[data-reveal]");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14 },
    );
    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing">
      <nav className="land-nav">
        <Brand />
        <div className={menu ? "nav-links open" : "nav-links"}>
          <a className="nav-report" href="/report">Report a domain</a>
          <a href="#platform">Platform</a>
          <a href="#pricing">Pricing</a>
          <a href="#agent">Agent</a>
          <a href="#docs">Docs</a>
        </div>
        <div className="nav-actions">
          <a href={`${appBase}/login`}>Sign in</a>
          <a className="land-button small" href={`${appBase}/register`}>
            Start deploying <ArrowRight size={14} />
          </a>
        </div>
        <button className="land-menu" onClick={() => setMenu(!menu)}>
          {menu ? <X /> : <Menu />}
        </button>
      </nav>
      <main>
        <section className="land-hero">
          <div className="hero-glow" />
          <div className="hero-badge">
            <Sparkles size={13} /> Production-ready server infrastructure
          </div>
          <h1>
            From idea to online.
            <br />
            <em>Under your control.</em>
          </h1>
          <p>
            Deploy websites, APIs and services on isolated compute. The Vyron
            platform performs only the server actions you explicitly start.
          </p>
          <div className="hero-actions">
            <a className="land-button" href={`${appBase}/register`}>
              Deploy your first app <ArrowRight size={16} />
            </a>
            <a className="land-link" href="#platform">
              Explore the platform <ChevronRight size={15} />
            </a>
          </div>
          <div className="hero-proof">
            <span>
              <Check size={13} /> No setup fees
            </span>
            <span>
              <Check size={13} /> Isolated servers
            </span>
            <span>
              <Check size={13} /> EU infrastructure
            </span>
          </div>
          <div className="product-window">
            <div className="window-top">
              <span>
                <i />
                <i />
                <i />
              </span>
              <div>app.vyronhosting.com</div>
            </div>
            <div className="window-body">
              <aside>
                <Brand />
                <span className="active">Overview</span>
                <span>Nodes</span>
                <span>Deployments</span>
                <span>Agent</span>
                <span>Domains</span>
              </aside>
              <div className="window-main">
                <small>OVERVIEW</small>
                <h3>Your infrastructure, at a glance.</h3>
                <div className="mini-stats">
                  <div>
                    <Cpu />
                    <span>
                      CPU usage<strong>34.2%</strong>
                    </span>
                  </div>
                  <div>
                    <Database />
                    <span>
                      Memory<strong>8.4 GB</strong>
                    </span>
                  </div>
                  <div>
                    <Zap />
                    <span>
                      Est. cost<strong>€23.84</strong>
                    </span>
                  </div>
                </div>
                <div className="deploy-card">
                  <span className="pulse" />
                  <div>
                    <strong>production-web</strong>
                    <small>Node.js · Basic</small>
                  </div>
                  <em>Running</em>
                  <b>34% CPU</b>
                </div>
                <div className="agent-strip">
                  <Bot size={17} />
                  <span>
                    <strong>Vyron Agent</strong>
                    <small>All systems healthy. No action required.</small>
                  </span>
                  <i>LIVE</i>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className="logo-cloud" data-reveal>
          <span>BUILT FOR WHAT'S NEXT</span>
          <div>
            <b>NODE.JS</b>
            <b>MINECRAFT</b>
            <b>NGINX</b>
            <b>PYTHON</b>
            <b>DOCKER</b>
          </div>
        </section>
        <section className="feature-section" id="platform" data-reveal>
          <div className="section-copy">
            <small>ONE CONTROL PLANE</small>
            <h2>
              Everything you need.
              <br />
              Nothing you don't.
            </h2>
            <p>
              Production-ready infrastructure without the traditional
              complexity. Build and operate from one quiet, focused workspace.
            </p>
          </div>
          <div className="feature-grid">
            <article className="feature big">
              <span>
                <Bot />
              </span>
              <small>AI HELPER</small>
              <h3>Get advice. Stay in control.</h3>
              <p>
                The helper recommends a package and template. Nothing is
                deployed until you review the checkout and explicitly confirm
                it.
              </p>
              <div className="agent-demo">
                <i>›</i>
                <span>Which package fits a Node.js API?</span>
                <button>
                  <ArrowRight />
                </button>
              </div>
            </article>
            <article className="feature">
              <span>
                <Globe2 />
              </span>
              <h3>Your chosen hostname</h3>
              <p>
                Reserve your desired Vyron hostname during setup. Public DNS
                activation is handled automatically by Vyron.
              </p>
              <div className="domain-demo">
                <b>cool</b>
                <span>.vyronhosting.com</span>
                <Check />
              </div>
            </article>
            <article className="feature">
              <span>
                <Gauge />
              </span>
              <h3>Know every resource</h3>
              <p>
                See reserved CPU, memory, disk, node status and billing in one
                place.
              </p>
              <div className="metric-demo">
                <i />
                <i />
                <i />
                <i />
                <svg viewBox="0 0 300 70">
                  <path
                    d="M0 58 C35 54 45 60 74 42 S120 50 150 29 S205 42 235 19 S270 24 300 7"
                    fill="none"
                    stroke="#8c70ef"
                    strokeWidth="2"
                  />
                </svg>
              </div>
            </article>
          </div>
        </section>
        <section className="agent-section" id="agent" data-reveal>
          <div className="agent-visual">
            <div className="orbit o1" />
            <div className="orbit o2" />
            <div className="agent-core">
              <Server />
            </div>
            <span className="agent-node n1">
              <Server />
              Compute
            </span>
            <span className="agent-node n2">
              <Globe2 />
              Network
            </span>
            <span className="agent-node n3">
              <ShieldCheck />
              Security
            </span>
            <span className="agent-node n4">
              <Code2 />
              Runtime
            </span>
          </div>
          <div className="section-copy">
            <small>VYRON AUTOMATION</small>
            <h2>Your server has a control agent.</h2>
            <p>
              The automation service securely creates and manages
              isolated compute nodes. The optional AI helper only gives
              advice; you approve every infrastructure action.
            </p>
            <ul>
              <li>
                <Check />
                Creates isolated compute nodes
              </li>
              <li>
                <Check />
                Installs production-ready templates
              </li>
              <li>
                <Check />
                Starts and stops nodes on request
              </li>
              <li>
                <Check />
                Never deploys without your order
              </li>
            </ul>
            <a className="land-link purple" href={`${appBase}/register`}>
              Open control panel <ArrowRight size={15} />
            </a>
          </div>
        </section>
        <section className="pricing" id="pricing" data-reveal>
          <div className="section-center">
            <small>SIMPLE PRICING</small>
            <h2>Start small. Scale when ready.</h2>
            <p>
              Clear monthly pricing. Change resources whenever your workload
              changes.
            </p>
          </div>
          <div className="price-grid">
            {offers.map((o) => (
              <article
                className={o.popular ? "price-card popular" : "price-card"}
                key={o.name}
              >
                {o.popular && <span className="popular-tag">MOST POPULAR</span>}
                <h3>{o.name}</h3>
                <p>{o.copy}</p>
                <div className="price">
                  <sup>€</sup>
                  {o.price}
                  <small>/ month</small>
                </div>
                <a href={`${appBase}/register`}>
                  Choose {o.name}
                  <ArrowRight size={14} />
                </a>
                <ul>
                  {o.items.map((i) => (
                    <li key={i}>
                      <Check size={14} />
                      {i}
                    </li>
                  ))}
                  <li>
                    <Check size={14} />
                    Server isolation
                  </li>
                  <li>
                    <Check size={14} />
                    Automation
                  </li>
                </ul>
              </article>
            ))}
          </div>
        </section>
        <section className="final-cta" data-reveal>
          <div>
            <Cloud />
            <h2>Your next project belongs online.</h2>
            <p>Go from blank server to production in minutes.</p>
            <a className="land-button light" href={`${appBase}/register`}>
              Start deploying <ArrowRight size={16} />
            </a>
          </div>
        </section>
      </main>
      <footer>
        <Brand />
        <p>A Vyron Technologies product.</p>
        <nav><a href="/terms">AGB</a><a href="/privacy">Datenschutz</a><a href="https://status.vyronpanel.com">Status</a></nav>
        <span>© 2026 Vyron Technologies</span>
      </footer>
    </div>
  );
}
