import { getSqlite } from "@/lib/db";
import { nanoid } from "nanoid";
import crypto from "node:crypto";
import { logger } from "@/lib/utils/logger";

const log = logger.child("webhooks");

export function createWebhook(workflowId: string, name: string): {
  id: string;
  secret: string;
  url: string;
} {
  const db = getSqlite();
  const id = nanoid(12);
  const secret = crypto.randomBytes(32).toString("hex");
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO webhooks (id, workflow_id, name, secret, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, workflowId, name, secret, 1, now);

  const url = `/api/webhooks/${id}`;

  log.info("Webhook created", { id, workflowId, url });

  return { id, secret, url };
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex")
  );
}
