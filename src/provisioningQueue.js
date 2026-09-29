import { provisionHotspotUser, buildMikrotikComment } from "./mikrotik.js";
import { sendMessage } from "./messaging.js";
import config from "./config.js";

// Retry backoff schedule (minutes per attempt index)
const BACKOFF_MINUTES = [2, 5, 10, 15, 30, 60, 60, 60, 60, 60];

/**
 * Adds a failed provisioning job to the retry queue.
 * The scheduler will keep retrying until max_attempts is reached.
 */
export async function enqueueProvisioning(
  db,
  { userId, phone, mikrotikProfile, planName, pin, durationStr },
) {
  await db.query(
    `
        INSERT INTO provisioning_queue
            (user_id, phone, mikrotik_profile, plan_name, pin, next_retry_at)
        VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '2 minutes')
    `,
    [userId, phone, mikrotikProfile, planName, pin],
  );

  console.log(`📋 Provisioning queued for ticket ${pin} (${phone}) — will retry in 2 minutes`);
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
        WHERE pq.status = 'pending' AND pq.next_retry_at <= NOW()
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
  console.log(`🔄 Provisioning attempt ${attempt}/${job.max_attempts} for ticket PIN ${job.pin} (${job.phone})`);

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

    if (attempt >= job.max_attempts) {
      await db.query(
        `
            UPDATE provisioning_queue SET status = 'abandoned' WHERE id = $1
        `,
        [job.id],
      );

      console.error(`🚫 Provisioning permanently failed for ticket ${job.pin} after ${attempt} attempts`);

      await sendMessage(
        job.phone,
        `⚠️ *Ticket Setup Delayed*\n\n` +
          `Your payment was received, but we've been unable to automatically connect with the hotspot router.\n\n` +
          `Your Login PIN is: \`${job.pin}\`\n\n` +
          `Please contact support to activate it manually:\n` +
          `📞 Support: *${config.supportPhone}*`,
        { sendToBoth: true },
      );
    } else {
      const backoffMins = BACKOFF_MINUTES[attempt] ?? 60;
      await db.query(
        `
            UPDATE provisioning_queue
            SET next_retry_at = NOW() + ($1 || ' minutes')::INTERVAL
            WHERE id = $2
        `,
        [backoffMins, job.id],
      );
      console.log(`⏳ Next retry for ticket ${job.pin} in ${backoffMins} minutes`);
    }
  }
}
