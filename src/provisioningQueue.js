import { provisionHotspotUser, buildMikrotikComment } from "./mikrotik.js";
import { sendMessage } from "./messaging.js";
import config from "./config.js";

// Retry interval: check quickly so when router/power comes online, tickets provision promptly (max 2-3 mins)
const RETRY_INTERVAL_MINUTES = 2;

/**
 * Adds a failed provisioning job to the retry queue.
 * The scheduler will keep retrying indefinitely until the router connects.
 */
export async function enqueueProvisioning(
  db,
  { userId, phone, mikrotikProfile, planName, pin, durationStr },
) {
  await db.query(
    `
        INSERT INTO provisioning_queue
            (user_id, phone, mikrotik_profile, plan_name, pin, next_retry_at)
        VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 minute')
    `,
    [userId, phone, mikrotikProfile, planName, pin],
  );

  console.log(`📋 Provisioning queued for ticket ${pin} (${phone}) — will retry automatically`);
}

/**
 * Processes all due pending provisioning jobs.
 * Called by the scheduler in index.js every minute.
 */
export async function processPendingQueue(db) {
  const due = await db.query(`
        SELECT pq.*, pl.duration_str 
        FROM provisioning_queue pq
        LEFT JOIN plans pl ON pl.mikrotik_profile = pq.mikrotik_profile
        WHERE pq.status IN ('pending', 'abandoned') AND pq.next_retry_at <= NOW()
        ORDER BY pq.next_retry_at ASC
        LIMIT 10
    `);

  if (!due.rows.length) return;

  console.log(`🔄 Processing ${due.rows.length} queued provisioning job(s)...`);

  for (const job of due.rows) {
    await processJob(db, job);
  }
}

async function processJob(db, job) {
  const attempt = job.attempts + 1;
  console.log(`🔄 Provisioning attempt ${attempt} for ticket PIN ${job.pin} (${job.phone})`);

  // Mark attempt in progress
  await db.query(
    `
        UPDATE provisioning_queue
        SET attempts = $1, last_attempted_at = NOW()
        WHERE id = $2
    `,
    [attempt, job.id],
  );

  try {
    const comment = buildMikrotikComment(job.phone, job.plan_name);

    await provisionHotspotUser(
      job.pin,
      job.mikrotik_profile,
      comment,
      job.duration_str || null,
    );

    // ✅ Success — mark complete and notify user
    await db.query(
      `
        UPDATE provisioning_queue SET status = 'completed' WHERE id = $1
    `,
      [job.id],
    );

    console.log(`✅ Provisioning succeeded for ticket PIN ${job.pin} on attempt ${attempt}`);

    await sendMessage(
      job.phone,
      `🎉 *Your ${config.ispName} Ticket is Ready!*\n\n` +
        `📦 Plan: *${job.plan_name}*\n` +
        `🎟️ *Login PIN:* \`${job.pin}\`\n\n` +
        `📶 *How to Connect:*\n` +
        `1. Connect to Wi-Fi (*${config.hotspotSsid}*)\n` +
        `2. Open your browser (*${config.portalUrl}*)\n` +
        `3. Enter Login PIN: \`${job.pin}\` in the box\n` +
        `4. Tap Connect & enjoy! 🛰️`,
      { sendToBoth: true },
    );
  } catch (err) {
    console.error(`❌ Provisioning attempt ${attempt} failed for ticket PIN ${job.pin}:`, err.message);

    // Never abandon a paid ticket! Keep retrying every 2 minutes until the router is reachable.
    await db.query(
      `
          UPDATE provisioning_queue
          SET next_retry_at = NOW() + ($1 || ' minutes')::INTERVAL
          WHERE id = $2
      `,
      [RETRY_INTERVAL_MINUTES, job.id],
    );
    console.log(`⏳ Next retry for ticket ${job.pin} in ${RETRY_INTERVAL_MINUTES} minutes (Attempt ${attempt})`);
  }
}
