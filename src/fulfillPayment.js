import { provisionHotspotUser, buildMikrotikComment, generatePin } from "./mikrotik.js";
import { enqueueProvisioning } from "./provisioningQueue.js";
import { sendMessage } from "./messaging.js";
import config from "./config.js";

/**
 * Generates a unique 7-digit numeric login PIN not currently active.
 */
export async function generateUniquePin(db) {
  let pin = generatePin();
  let attempts = 0;
  while (attempts < 10) {
    const check = await db.query(
      "SELECT 1 FROM subscriptions WHERE pin = $1 AND status = 'active'",
      [pin],
    );
    if (check.rowCount === 0) return pin;
    pin = generatePin();
    attempts++;
  }
  return pin;
}

/**
 * Fulfills a confirmed payment:
 * Generates a Ticket PIN, provisions into MikroTik, and sends the ticket to the user.
 *
 * @param {object} db          - pg Pool instance
 * @param {object} user        - Full user row from the `users` table
 * @param {number} amountPaid  - Amount received from payment webhook
 */
export async function fulfillPayment(db, user, amountPaid) {
  console.log(`💬 fulfillPayment: phone=${user.phone}, amount=${amountPaid}`);

  // 1. Fetch session data
  const sessionRes = await db.query(
    `SELECT plan_id FROM chat_sessions WHERE phone = $1`,
    [user.phone],
  );
  const session = sessionRes.rows[0];

  // 2. Find the user's latest pending payment
  const paymentRes = await db.query(
    `
        SELECT * FROM payments
        WHERE user_id = $1 AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
    `,
    [user.id],
  );

  const payment = paymentRes.rows[0];
  if (!payment) {
    await sendMessage(
      user.phone,
      `⚠️ We couldn't find a pending payment on your account. Please send *HI* to purchase a ticket.`,
    );
    return;
  }

  // 3. Get the selected plan
  let planId = session?.plan_id;
  if (!planId && amountPaid) {
    // Fallback: match plan by price if session plan_id was cleared or missing
    const planByPrice = await db.query(
      `SELECT id FROM plans WHERE price = $1 ORDER BY id LIMIT 1`,
      [amountPaid],
    );
    if (planByPrice.rows[0]) {
      planId = planByPrice.rows[0].id;
    }
  }

  if (!planId) {
    await sendMessage(
      user.phone,
      `⚠️ We couldn't find your selected plan. Please send *HI* to choose a plan or contact support (${config.supportPhone}).`,
    );
    return;
  }

  const planRes = await db.query(`SELECT * FROM plans WHERE id = $1`, [planId]);
  const plan = planRes.rows[0];

  if (!plan) {
    await sendMessage(
      user.phone,
      `⚠️ Your selected plan no longer exists. Please send *HI* to choose a new one.`,
    );
    return;
  }

  // 4. Validate amount paid
  if (Number(amountPaid) < Number(plan.price)) {
    console.warn(
      `⚠️ fulfillPayment: underpayment — expected ₦${plan.price}, got ₦${amountPaid}`,
    );
    await sendMessage(
      user.phone,
      `⚠️ *Underpayment Detected*\n\n` +
      `We received *₦${Number(amountPaid).toLocaleString()}* but your plan requires *₦${Number(plan.price).toLocaleString()}*.\n\n` +
      `Please transfer the remaining *₦${(plan.price - amountPaid).toLocaleString()}* to the same account number.`,
    );
    return;
  }

  // 5. Atomically mark payment as completed
  const claimRes = await db.query(
    `UPDATE payments SET status = 'completed', paid_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [payment.id],
  );
  if (claimRes.rowCount === 0) {
    console.log(`⚠️ fulfillPayment: payment ${payment.id} already processed — skipping duplicate`);
    return;
  }

  // 6. Generate unique Ticket PIN
  const pin = await generateUniquePin(db);

  // 7. Calculate estimated expiry for DB records
  const expiryTime = new Date();
  if (plan.duration_str && plan.duration_str.includes("01:00:00")) {
    expiryTime.setHours(expiryTime.getHours() + 1);
  } else {
    const days = Number(plan.duration_days) || 1;
    expiryTime.setTime(expiryTime.getTime() + days * 24 * 60 * 60 * 1000);
  }

  // 8. Record subscription
  await db.query(
    `
        INSERT INTO subscriptions (user_id, plan_id, pin, status, start_time, expiry_time, alert_sent)
        VALUES ($1, $2, $3, 'active', CURRENT_TIMESTAMP, $4, false)
    `,
    [user.id, plan.id, pin, expiryTime],
  );

  // Update latest pin on users record for tracking
  await db.query(
    `UPDATE users SET hotspot_username = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [pin, user.id],
  );

  // Reset chat session
  await db.query(
    `UPDATE chat_sessions SET state = 'start', plan_id = NULL WHERE phone = $1`,
    [user.phone],
  );

  // 9. Provision ticket into MikroTik or Queue
  await provisionOrQueueTicket(db, user, plan, pin);
}

/**
 * Provisions the ticket into MikroTik or queues it if the router is offline.
 */
export async function provisionOrQueueTicket(
  db,
  user,
  plan,
  pin,
  suppressSuccessMessage = false,
) {
  const comment = buildMikrotikComment(user.phone, plan.name);

  try {
    await provisionHotspotUser(
      pin,
      plan.mikrotik_profile,
      comment,
      plan.duration_str || null,
    );

    console.log(`✅ Ticket PIN ${pin} provisioned on MikroTik for ${user.phone}`);

    if (!suppressSuccessMessage) {
      await sendMessage(
        user.phone,
        `🎉 *Payment Confirmed!*\n\n` +
        `📦 Plan: *${plan.name}* (₦${Number(plan.price).toLocaleString()})\n` +
        `🎟️ *Your Hotspot Login PIN:* \`${pin}\`\n\n` +
        `📶 *How to Connect:*\n` +
        `1. Connect to Wi-Fi (*${config.hotspotSsid}*)\n` +
        `2. Open your browser (*${config.portalUrl}*)\n` +
        `3. Enter your Login PIN: \`${pin}\` in the box\n` +
        `4. Tap Connect & enjoy! 🚀`,
        { sendToBoth: true },
      );
    }
  } catch (err) {
    console.error(`MikroTik ticket provisioning failed for ${pin} — queuing:`, err.message);

    if (!suppressSuccessMessage) {
      await sendMessage(
        user.phone,
        `✅ *Payment Confirmed!*\n\n` +
        `📦 Plan: *${plan.name}*\n` +
        `🎟️ *Your Login PIN:* \`${pin}\`\n\n` +
        `⚙️ Router connection is syncing. Your PIN \`${pin}\` will be active within 2 minutes.\n\n` +
        `Connect to Wi-Fi (*${config.hotspotSsid}*) and enter Login PIN: \`${pin}\` to connect!`,
        { sendToBoth: true },
      );
    }

    try {
      await enqueueProvisioning(db, {
        userId: user.id,
        phone: user.phone,
        mikrotikProfile: plan.mikrotik_profile,
        planName: plan.name,
        pin,
        durationStr: plan.duration_str,
      });
    } catch (queueErr) {
      console.error("Failed to enqueue provisioning job:", queueErr.message);
    }
  }
}

// Keep export alias for any legacy callers
export const provisionOrQueue = provisionOrQueueTicket;
