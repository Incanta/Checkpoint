import "server-only";

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import config from "@incanta/config";
import { Logger } from "../logging";

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const TRANSPORTER_KEY = Symbol.for("checkpoint.email.transporter");

const globalForEmail = globalThis as unknown as {
  [TRANSPORTER_KEY]?: Transporter | null;
};

function getCachedTransporter(): Transporter | null {
  return globalForEmail[TRANSPORTER_KEY] ?? null;
}
function setCachedTransporter(t: Transporter | null) {
  globalForEmail[TRANSPORTER_KEY] = t;
}

async function getTransporter(): Promise<Transporter | null> {
  const cached = getCachedTransporter();
  if (cached) return cached;

  const enabled = config.get<boolean>("email.enabled");
  if (!enabled) return null;

  const host = config.get<string>("email.smtp.host");
  const port = config.get<number>("email.smtp.port");
  const secure = config.get<boolean>("email.smtp.secure");
  const user = config.get<string>("email.smtp.auth.user");
  const pass = await config.getWithSecrets<string>("email.smtp.auth.pass");

  if (!host) return null;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    ...(user && pass ? { auth: { user, pass } } : {}),
  });

  setCachedTransporter(transporter);
  return transporter;
}

function getFrom(): { name: string; address: string } {
  return {
    name: config.get<string>("email.from.name") || "Checkpoint VCS",
    address: config.get<string>("email.from.address") || "noreply@example.com",
  };
}

export async function sendEmail(message: EmailMessage): Promise<boolean> {
  const transporter = await getTransporter();
  if (!transporter) {
    Logger.warn("[email] Email is disabled or not configured — skipping send");
    return false;
  }

  try {
    await transporter.sendMail({
      from: getFrom(),
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return true;
  } catch (err: any) {
    Logger.error(`[email] Failed to send email: ${JSON.stringify(err)}`);
    return false;
  }
}

export function isEmailEnabled(): boolean {
  try {
    return config.get<boolean>("email.enabled") === true;
  } catch {
    return false;
  }
}

/** Reset cached transporter (useful if config changes at runtime). */
export function resetTransporter(): void {
  setCachedTransporter(null);
}
