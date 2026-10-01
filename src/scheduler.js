import { sendMessage } from "./messaging.js";
import { processPendingQueue } from "./provisioningQueue.js";
import {
  removeHotspotUser,
  removeActiveSessions,
  getActiveSessions,
  getHotspotUser,
  updateHotspotUser,
  calculateExpiryDate,
} from "./mikrotik.js";
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
// Job B — Activate tickets on first login (Runs every 1 minute)
// ─────────────────────────────────────────────────────────────────────────────
// Finds active subscriptions that have not started counting yet (start_time IS NULL).
// Checks MikroTik to see if the user has logged in (in active sessions or uptime > 0).
// When detected:
//  - sets start_time = NOW()
//  - calculates expiry_time = NOW() + plan_duration
//  - notifies the user on WhatsApp that their time is now counting
// ─────────────────────────────────────────────────────────────────────────────
async function activateNewLogins(db) {
  try {
    const { rows: unactivated } = await db.query(`
      SELECT s.id, s.pin, pl.id AS plan_id, pl.name AS plan_name,
             pl.duration_days, pl.duration_str, COALESCE(pl.shared_users, 1) AS shared_users, u.phone
      FROM subscriptions s
      JOIN plans pl ON pl.id = s.plan_id
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.status = 'active'
        AND s.start_time IS NULL
      LIMIT 50
    `);

    if (!unactivated.length) return;

    // Fetch active sessions from MikroTik (fastest check for who is currently online)
    const activeSessions = await getActiveSessions();
    const activePins = new Set(activeSessions.map((s) => String(s.user)));

    for (const sub of unactivated) {
      const pinStr = String(sub.pin);
      let hasLoggedIn = activePins.has(pinStr);

      // If not currently connected, check if router reports any uptime accumulated
      if (!hasLoggedIn) {
        const mkUser = await getHotspotUser(pinStr);
        if (mkUser && mkUser.uptime && mkUser.uptime !== "0s" && mkUser.uptime !== "00:00:00") {
          hasLoggedIn = true;
        }
      }

      if (hasLoggedIn) {
        const now = new Date();
        const expiryTime = calculateExpiryDate(sub, now);

        await db.query(
          `UPDATE subscriptions 
           SET start_time = $1, expiry_time = $2 
           WHERE id = $3`,
          [now, expiryTime, sub.id],
        );

        console.log(`🚀 Activated ticket PIN ${sub.pin} (${sub.plan_name}) — expires at ${expiryTime.toLocaleString()}`);

        // Lock MAC address for 1-device plans if currently connected
        if (Number(sub.shared_users) === 1) {
          const session = activeSessions.find((s) => String(s.user) === pinStr);
          if (session && session["mac-address"]) {
            try {
              const mkUser = await getHotspotUser(pinStr);
              if (mkUser && mkUser[".id"] && (!mkUser["mac-address"] || mkUser["mac-address"] === "00:00:00:00:00:00")) {
                await updateHotspotUser(mkUser[".id"], { "mac-address": session["mac-address"] });
                console.log(`🔒 Locked ticket PIN ${sub.pin} to MAC ${session["mac-address"]}`);
              }
            } catch (macErr) {
              console.warn(`⚠️ Could not bind MAC for PIN ${sub.pin}:`, macErr.message);
            }
          }
        }

        if (sub.phone) {
          const formattedExpiry = expiryTime.toLocaleString("en-GB", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
          await sendMessage(
            sub.phone,
            `🚀 *Your ${config.ispName} Ticket is Now Active!*\n\n` +
            `📦 Plan: *${sub.plan_name}*\n` +
            `🎟️ PIN: \`${sub.pin}\`\n` +
            `⏰ *Valid Until:* ${formattedExpiry}\n\n` +
            `Enjoy high-speed browsing! 🛰️`,
            { sendToBoth: true },
          );
        }
      }
    }
  } catch (err) {
    console.error("Scheduler: activateNewLogins error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job C — Expire overdue tickets (Runs every 2 minutes)
// ─────────────────────────────────────────────────────────────────────────────
// Finds active subscriptions that have been activated (start_time IS NOT NULL)
// whose wall-clock expiry_time has passed.
// Double-checks that the user actually used time on MikroTik before removal.
// Removes the PIN from MikroTik, marks DB expired, and notifies user.
// ─────────────────────────────────────────────────────────────────────────────
async function expireOverdueTickets(db) {
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.pin, s.expiry_time, u.phone, pl.name AS plan_name
      FROM subscriptions s
      JOIN users u  ON u.id  = s.user_id
      JOIN plans pl ON pl.id = s.plan_id
      WHERE s.status = 'active'
        AND s.start_time IS NOT NULL
        AND s.expiry_time IS NOT NULL
        AND s.expiry_time < NOW()
      ORDER BY s.expiry_time ASC
      LIMIT 20
      FOR UPDATE OF s SKIP LOCKED
    `);

    if (!rows.length) return;

    console.log(`⏰ Expiry job: found ${rows.length} overdue activated ticket(s)`);

    for (const sub of rows) {
      try {
        // Safety check: verify router state
        const pinStr = String(sub.pin);
        const mkUser = await getHotspotUser(pinStr);
        if (mkUser && (!mkUser.uptime || mkUser.uptime === "0s" || mkUser.uptime === "00:00:00")) {
          // Extra guard: If user has 0 uptime on router, they never actually used it!
          // Reset them to unactivated state so they don't lose their ticket.
          console.warn(`⚠️ Ticket PIN ${pinStr} has 0 uptime on router — resetting to unactivated state.`);
          await db.query(`UPDATE subscriptions SET start_time = NULL, expiry_time = NULL WHERE id = $1`, [sub.id]);
          continue;
        }

        // 1. Kick any active session
        await removeActiveSessions(pinStr);

        // 2. Remove from MikroTik (silently handles already-removed users)
        await removeHotspotUser(pinStr);

        // 3. Mark expired in DB
        await db.query(
          `UPDATE subscriptions SET status = 'expired' WHERE id = $1`,
          [sub.id],
        );

        console.log(`✅ Expired ticket PIN ${sub.pin} (${sub.plan_name}) for ${sub.phone || "Walk-in"}`);

        // 4. Notify the user
        if (sub.phone) {
          await sendMessage(
            sub.phone,
            `⏰ *Your ${config.ispName} Plan Has Expired*\n\n` +
            `📦 Plan: *${sub.plan_name}*\n` +
            `🎟️ PIN: \`${sub.pin}\`\n\n` +
            `To continue enjoying internet access, send *Hi* to purchase a new plan. 🚀`,
            { sendToBoth: true },
          );
        }
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

  // 1. Run provisioning queue check every 30 seconds
  setInterval(() => {
    processPendingQueue(db).catch((err) =>
      console.error("Error in processPendingQueue:", err.message),
    );
  }, 30 * 1000);

  // 2. Run first-login activation check every 60 seconds
  setInterval(() => {
    activateNewLogins(db).catch((err) =>
      console.error("Error in activateNewLogins:", err.message),
    );
  }, 60 * 1000);

  // 3. Run ticket expiry check every 2 minutes
  setInterval(() => {
    expireOverdueTickets(db).catch((err) =>
      console.error("Error in expireOverdueTickets:", err.message),
    );
  }, 2 * 60 * 1000);

  // 4. Run offline message retries every 3 minutes
  setInterval(() => {
    retryOfflineMessages(db).catch((err) =>
      console.error("Error in retryOfflineMessages:", err.message),
    );
  }, 3 * 60 * 1000);
}
