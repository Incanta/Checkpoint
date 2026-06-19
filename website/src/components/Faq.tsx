"use client";

import { JSX, useState } from "react";

const faqs = [
  {
    question: "Do you support large binary files like textures, meshes, or video?",
    answer:
      (<span>
        That's exactly what Checkpoint is built for. There are no artificial
        file size limits. Large binaries are stored and transferred efficiently
        without bloating history, unlike systems that bolt on LFS as an afterthought.
      </span>),
  }
];

function FaqItem({ question, answer }: { question: string; answer: JSX.Element }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="glass rounded-2xl overflow-hidden transition-all duration-300">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-4 px-6 py-5 text-left hover:bg-surface-hover transition-colors"
        aria-expanded={open}
      >
        <span className="text-sm font-medium">{question}</span>
        <svg
          className={`w-4 h-4 text-muted shrink-0 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <div
        className={`grid transition-all duration-300 ease-in-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <p className="px-6 pb-5 text-sm text-muted leading-relaxed">
            {answer}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Faq() {
  return (
    <section id="faq" className="relative py-32 overflow-hidden">
      {/* Divider glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2/3 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      <div className="mx-auto max-w-3xl px-6 lg:px-8">
        {/* Section header */}
        <div className="text-center mb-12">
          <p className="text-sm font-semibold uppercase tracking-wider text-primary mb-3">
            FAQ
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Frequently asked questions
          </h2>
          <p className="text-muted text-lg">
            Still have questions?{" "}
            <a
              href="https://github.com/Incanta/Checkpoint/discussions"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-light hover:underline"
            >
              Ask on GitHub
            </a>
            .
          </p>
        </div>

        {/* Accordion */}
        <div className="space-y-3">
          {faqs.map((faq) => (
            <FaqItem key={faq.question} question={faq.question} answer={faq.answer} />
          ))}
        </div>
      </div>
    </section>
  );
}
