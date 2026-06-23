"use client";

import { type JSX, useState } from "react";
import CloudInterestModal from "./CloudInterestModal";

const faqs: {
  question: string;
  answer: (props: { onSubmitInterest: () => void }) => JSX.Element;
}[] = [
  {
    question:
      "Do you support large binary files like textures, meshes, or video?",
    answer: () => (
      <span>
        That&apos;s exactly what Checkpoint is built for. There are no
        artificial file size limits. Large binaries are stored and transferred
        efficiently without bloating history, unlike systems that bolt on LFS as
        an afterthought.
      </span>
    ),
  },
  {
    question:
      "Why the dual licensing? How does it compare to something like MIT? Can I use it for commercial projects?",
    answer: () => (
      <span>
        <strong>
          This is not legal advice; read the licenses for full details.
        </strong>
        <br />
        <br />
        Rest assured, if you&apos;re a commercial studio using Checkpoint{" "}
        <strong>internally</strong>, you can do so freely under the Elastic
        License 2.0; you won&apos;t have any payment or open source obligations.
        You could probably treat it like you would for MIT-licensed software.
        <br />
        <br />
        The Elastic License 2.0 primarily restricts you from having a hosted
        service of Checkpoint to third parties. If you need to do this, you can
        do so under the OSI-approved AGPLv3 license.{" "}
        <strong>
          NOTE: This license has more copyleft restrictions which may require
          you to open source more than you want. Please consult with a lawyer to
          see if it fits your use case.
        </strong>
        <br />
        <br />
        We chose this dual licensing approach to prevent the large VCS hosting
        providers from financially benefiting from Checkpoint without
        significantly contributing back to the community.
      </span>
    ),
  },
  {
    question: "Will there be a managed cloud service for Checkpoint?",
    answer: ({ onSubmitInterest }) => (
      <span>
        This is something we&apos;re actively exploring. You&apos;ll see some
        references to a hosted service in the source code, but we&apos;ve paused
        development to focus on the self-hosted experience and see if
        there&apos;s enough demand for a managed service.{" "}
        <button
          type="button"
          onClick={onSubmitInterest}
          className="text-primary-light hover:underline"
        >
          Register your interest
        </button>{" "}
        to help us gauge demand.
      </span>
    ),
  },
];

function FaqItem({
  question,
  answer,
  onSubmitInterest,
}: {
  question: string;
  answer: (props: { onSubmitInterest: () => void }) => JSX.Element;
  onSubmitInterest: () => void;
}) {
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
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      <div
        className={`grid transition-all duration-300 ease-in-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <p className="px-6 pb-5 text-sm text-muted leading-relaxed">
            {answer({ onSubmitInterest })}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Faq() {
  const [modalOpen, setModalOpen] = useState(false);

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
            <FaqItem
              key={faq.question}
              question={faq.question}
              answer={faq.answer}
              onSubmitInterest={() => setModalOpen(true)}
            />
          ))}
        </div>
      </div>

      <CloudInterestModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </section>
  );
}
