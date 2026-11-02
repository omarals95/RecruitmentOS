import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  Check,
  Code2,
  FileText,
  KanbanSquare,
  LockKeyhole,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Brand } from "@/components/workspace/shell";

export default function Home() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <Link href="/" aria-label="RecruitmentOS home">
          <Brand />
        </Link>
        <nav aria-label="Homepage">
          <a href="#workspace">The workspace</a>
          <a href="#connected">Connected by design</a>
          <Link href="/sign-in" className="button secondary">
            Sign in
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </nav>
      </header>
      <main>
        <section className="landing-hero">
          <div className="hero-copy">
            <p className="eyebrow">
              <span />
              One workspace. Every next step.
            </p>
            <h1>
              Good hiring starts
              <br />
              with a clearer view.
            </h1>
            <p className="hero-description">
              Bring your candidates, open roles and recruitment workflows
              together. Less searching through files. More time moving the right
              conversations forward.
            </p>
            <div className="hero-actions">
              <Link href="/app" className="button large">
                Open your workspace
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <a href="#workspace" className="text-link">
                Explore RecruitmentOS
                <ArrowDown />
              </a>
            </div>
            <div className="hero-assurances">
              <span>
                <Check size={15} aria-hidden="true" />
                Private CV storage
              </span>
              <span>
                <Check size={15} aria-hidden="true" />
                Team permissions
              </span>
              <span>
                <Check size={15} aria-hidden="true" />
                Your workflow
              </span>
            </div>
          </div>
          <div
            className="hero-product"
            aria-label="Illustration of connected recruitment workflows"
          >
            <div className="illustration-top">
              <span className="mini-brand">
                R<span>OS</span>
              </span>
              <span>YOUR RECRUITMENT WORKSPACE</span>
              <span className="illustration-dot" />
            </div>
            <div className="illustration-layout">
              <div className="illustration-sidebar">
                <Users />
                <BriefcaseBusiness />
                <KanbanSquare />
                <FileText />
              </div>
              <div className="illustration-content">
                <div className="illustration-heading">
                  <span>
                    From first contact
                    <br />
                    <strong>to a great first day.</strong>
                  </span>
                  <span className="illustration-plus">+</span>
                </div>
                <div className="illustration-search">
                  <Search size={14} />
                  <span>Find the next conversation</span>
                </div>
                <div className="illustration-board">
                  {[
                    {
                      name: "Sourced",
                      tone: "amber",
                      text: "Discover potential",
                      icon: Search,
                    },
                    {
                      name: "Interview",
                      tone: "purple",
                      text: "Start a conversation",
                      icon: Users,
                    },
                    {
                      name: "Onboarding",
                      tone: "green",
                      text: "Make a great start",
                      icon: Check,
                    },
                  ].map(({ name, tone, text, icon: Icon }) => (
                    <div key={name}>
                      <span className={`illustration-stage ${tone}`}>
                        {name}
                        <span>•</span>
                      </span>
                      <div className="illustration-card">
                        <span className={`illustration-icon ${tone}`}>
                          <Icon size={18} />
                        </span>
                        <strong>{text}</strong>
                        <div className="skeleton-line" />
                        <div className="skeleton-line short" />
                        <span className="illustration-card-footer">
                          A clear next step
                          <ArrowUpRight size={13} />
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="illustration-bottom">
                  <ShieldCheck size={16} />
                  <span>Connected records. Human decisions.</span>
                </div>
              </div>
            </div>
            <div className="floating-note">
              <span>
                <Check size={15} />
              </span>
              Everything in its right place.
            </div>
          </div>
        </section>
        <section className="landing-strip">
          <span>Built around the way recruiters work</span>
          <span>CANDIDATES</span>
          <span>VACANCIES</span>
          <span>PIPELINES</span>
          <span>TEAMWORK</span>
        </section>
        <section id="workspace" className="landing-section">
          <div className="section-intro">
            <p className="eyebrow">A calmer recruitment day</p>
            <h2>
              The whole picture.
              <br />
              The details that matter.
            </h2>
            <p>
              A practical workspace that connects the recruitment process
              without turning every decision into another spreadsheet.
            </p>
          </div>
          <div className="feature-grid">
            {[
              {
                icon: Users,
                title: "Your talent, easy to find",
                text: "Search candidate facts, skills and certifications. Keep original folder categories, source evidence and personal follow-up notes close at hand.",
              },
              {
                icon: BriefcaseBusiness,
                title: "Roles with real context",
                text: "Create reusable job roles and vacancies. Link applications, interviews and offers to the role that started the conversation.",
              },
              {
                icon: KanbanSquare,
                title: "A workflow that fits your team",
                text: "Customize recruitment task buckets and fields. Move applications through clear, manual stages and see what needs attention.",
              },
              {
                icon: ShieldCheck,
                title: "Private by design",
                text: "Keep CVs in private storage with time-limited downloads. Work in separate teams with explicit user roles and a traceable history.",
              },
            ].map(({ icon: Icon, title, text }) => (
              <article className="feature-card" key={title}>
                <span className="feature-icon">
                  <Icon size={23} aria-hidden="true" />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>
        <section id="connected" className="connected-section">
          <div>
            <p className="eyebrow">Connected by design</p>
            <h2>
              Your tools can work
              <br />
              as part of the team.
            </h2>
            <p>
              Give an AI assistant or integration just the access it needs with
              scoped API tokens. Read records, add candidate data or upload CVs
              while keeping people, permissions and decisions in control.
            </p>
            <Link href="/app/settings/api-tokens" className="text-link">
              Explore your integration settings
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <div className="connection-diagram">
            <div className="connection-node">
              <Code2 size={22} />
              <span>Your integration</span>
            </div>
            <span className="connection-line" />
            <div className="connection-node connection-core">
              <LockKeyhole size={24} />
              <strong>Scoped API token</strong>
              <small>One user · One team · Explicit permissions</small>
            </div>
            <span className="connection-line" />
            <div className="connection-node">
              <Brand />
            </div>
          </div>
        </section>
        <section className="landing-cta">
          <span className="eyebrow">Make room for better conversations</span>
          <h2>
            Your next recruitment day,
            <br />a little more organized.
          </h2>
          <Link href="/sign-in" className="button large">
            Sign in to RecruitmentOS
            <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <p>
            Joining an existing team? Use the email address on your invitation.
          </p>
        </section>
      </main>
      <footer className="landing-footer">
        <Brand />
        <p>A clear workspace for the people behind every hire.</p>
        <Link href="/sign-in">
          Sign in
          <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </footer>
    </div>
  );
}
function ArrowDown() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M12 4v16m-6-6 6 6 6-6" />
    </svg>
  );
}
