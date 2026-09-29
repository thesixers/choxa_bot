import { sendMessage } from "./messaging.js";
import { processPendingQueue } from "./provisioningQueue.js";
import { removeHotspotUser } from "./mikrotik.js";
import config from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Job A — Retry sending queued offline messages (Runs every 3 minutes)
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: Messages land here when a user has no chat_session yet (e.g. admin
// generated a ticket for someone who hasn't messaged the bot). They stay
// 'pending' until the user starts a conversation and a session is created.
// ─────────────────────────────────────────────────────────────────────────────
async function retryOfflineMessages(db) {
  try {
    const res = await db.query(`
      SELECT id, phone, message_text, send_to_both, attempts
      FROM message_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    `);

    if (res.rows.length === 0) return;

    for (const msg of res.rows) {
      try {
        const delivered = await sendMessage(msg.phone, msg.message_text, {
          sendToBoth: msg.send_to_both,
          isOfflineRetry: true,
        });

        if (delivered) {
          // Successfully delivered — mark sent
          await db.query(
            `UPDATE message_queue SET status = 'sent', last_attempted_at = NOW() WHERE id = $1`,
            [msg.id],
          );
          console.log(`✅ Queued message ${msg.id} delivered to ${msg.phone}`);
        } else {
          // Increment attempts so unreachable phones don't stay pending forever
          const nextAttempt = (msg.attempts || 0) + 1;
          const newStatus = nextAttempt >= 5 ? "failed" : "pending";

          await db.query(
            `UPDATE message_queue SET attempts = $1, status = $2, last_attempted_at = NOW() WHERE id = $3`,
            [nextAttempt, newStatus, msg.id],
          );

          if (newStatus === "failed") {
            console.warn(`⚠️ Queued message ${msg.id} for ${msg.phone} failed after ${nextAttempt} attempts — marked failed.`);
          }
        }
      } catch (err) {
        // A real send error (network, Telegram API, etc.) — increment attempts
        const nextAttempt = (msg.attempts || 0) + 1;
        const newStatus = nextAttempt >= 5 ? "failed" : "pending";

        await db.query(
          `UPDATE message_queue SET attempts = $1, status = $2, last_attempted_at = NOW() WHERE id = $3`,
          [nextAttempt, newStatus, msg.id],
        );

        if (newStatus === "failed") {
          console.warn(`⚠️ Queued message ${msg.id} for ${msg.phone} failed after ${nextAttempt} attempts — marked failed.`);
        }
      }
    }
  } catch (err) {
    console.error("Scheduler: retryOfflineMessages error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job B — Expire overdue tickets (Runs every 5 minutes)
// ─────────────────────────────────────────────────────────────────────────────
// Finds active subscriptions whose wall-clock expiry_time has passed,
// removes the PIN from MikroTik, marks the subscription expired in the DB,
// and sends the user a notification.
// ─────────────────────────────────────────────────────────────────────────────
async function expireOverdueTickets(db) {
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.pin, s.expiry_time, u.phone, pl.name AS plan_name
      FROM subscriptions s
      JOIN users u  ON u.id  = s.user_id
      JOIN plans pl ON pl.id = s.plan_id
      WHERE s.status = 'active'
        AND s.expiry_time IS NOT NULL
        AND s.expiry_time < NOW()
      ORDER BY s.expiry_time ASC
      LIMIT 20
      FOR UPDATE OF s SKIP LOCKED
    `);

    if (!rows.length) return;

    console.log(`⏰ Expiry job: found ${rows.length} overdue ticket(s)`);

    for (const sub of rows) {
      try {
        // 1. Remove from MikroTik (silently handles already-removed users)
        await removeHotspotUser(sub.pin);

        // 2. Mark expired in DB
        await db.query(
          `UPDATE subscriptions SET status = 'expired' WHERE id = $1`,
          [sub.id]
        );

        console.log(`✅ Expired ticket PIN ${sub.pin} (${sub.plan_name}) for ${sub.phone}`);

        // 3. Notify the user
        await sendMessage(
          sub.phone,
          `⏰ *Your ${config.ispName} Plan Has Expired*\n\n` +
          `📦 Plan: *${sub.plan_name}*\n` +
          `🎟️ PIN: \`${sub.pin}\`\n\n` +
          `To continue enjoying internet access, send *Hi* to purchase a new plan. 🚀`,
          { sendToBoth: true }
        );
      } catch (err) {
        console.error(`❌ Failed to expire ticket PIN ${sub.pin}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Scheduler: expireOverdueTickets error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// START SCHEDULER
// ─────────────────────────────────────────────────────────────────────────────
export function startScheduler(db) {
  console.log("⏱️  Scheduler started.");

  // Run provisioning queue check every 30 seconds
  setInterval(() => {
    processPendingQueue(db).catch((err) =>
      console.error("Error in processPendingQueue:", err.message),
    );
  }, 30 * 1000);

  // Run offline message retries every 3 minutes
  setInterval(() => {
    retryOfflineMessages(db).catch((err) =>
      console.error("Error in retryOfflineMessages:", err.message),
    );
  }, 3 * 60 * 1000);

  // Run ticket expiry check every 5 minutes
  setInterval(() => {
    expireOverdueTickets(db).catch((err) =>
      console.error("Error in expireOverdueTickets:", err.message),
    );
  }, 5 * 60 * 1000);
}
