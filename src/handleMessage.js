import {
  createDynamicVirtualAccount,
  verifyVirtualAccountPayment,
} from "./flutterwave.js";
import { fulfillPayment } from "./fulfillPayment.js";
import { sendMessage } from "./messaging.js";
import { handleAdminMessage } from "./adminHandler.js";
import config from "./config.js";

const EMOJI_NUMS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

// ---------------------------------------------------------
// DATABASE HELPERS
// ---------------------------------------------------------

async function upsertUser(db, phone, pushName = null) {
  let res = await db.query("SELECT * FROM users WHERE phone = $1", [phone]);
  if (res.rows.length === 0) {
    res = await db.query(
      `INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING *`,
      [phone, pushName],
    );
  } else {
    res = await db.query(
      `UPDATE users SET updated_at = CURRENT_TIMESTAMP, name = COALESCE($2, name) WHERE phone = $1 RETURNING *`,
      [phone, pushName],
    );
  }
  return res.rows[0];
}

async function getSession(db, phone) {
  const res = await db.query(
    "SELECT state, plan_id, remote_jid, telegram_chat_id, preferred_platform FROM chat_sessions WHERE phone = $1",
    [phone],
  );
  return res.rows.length > 0
    ? res.rows[0]
    : {
      state: "start",
      plan_id: null,
      remote_jid: null,
      telegram_chat_id: null,
      preferred_platform: "whatsapp",
    };
}

async function updateSession(db, phone, state, planId = null, platform = null, remoteId = null) {
  const isWhatsapp = platform === "whatsapp";
  const isTelegram = platform === "telegram";

  await db.query(
    `
        INSERT INTO chat_sessions (phone, state, plan_id, remote_jid, telegram_chat_id, preferred_platform, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        ON CONFLICT (phone) DO UPDATE
        SET state               = EXCLUDED.state,
            plan_id             = COALESCE(EXCLUDED.plan_id, chat_sessions.plan_id),
            remote_jid          = COALESCE(EXCLUDED.remote_jid, chat_sessions.remote_jid),
            telegram_chat_id    = COALESCE(EXCLUDED.telegram_chat_id, chat_sessions.telegram_chat_id),
            preferred_platform  = COALESCE(EXCLUDED.preferred_platform, chat_sessions.preferred_platform),
            last_updated        = CURRENT_TIMESTAMP
    `,
    [
      phone,
      state,
      planId,
      isWhatsapp ? remoteId : null,
      isTelegram ? remoteId : null,
      platform || "whatsapp",
    ],
  );
}

async function getPlan(db, id) {
  const res = await db.query(
    "SELECT id, name, price, duration_days, duration_str, speed_limit, shared_users, mikrotik_profile FROM plans WHERE id = $1",
    [id],
  );
  return res.rows.length > 0 ? res.rows[0] : null;
}

async function getAllPlans(db) {
  const res = await db.query(
    "SELECT id, name, price, duration_days, duration_str, speed_limit, shared_users, mikrotik_profile FROM plans ORDER BY price ASC, shared_users ASC",
  );
  return res.rows;
}

async function getUserTickets(db, userId) {
  const res = await db.query(
    `
        SELECT s.pin, pl.name AS plan_name, pl.price, pl.duration_str, s.created_at, s.status
        FROM subscriptions s
        JOIN plans pl ON pl.id = s.plan_id
        WHERE s.user_id = $1
        ORDER BY s.created_at DESC
        LIMIT 5
    `,
    [userId],
  );
  return res.rows;
}

async function getPaymentHistory(db, userId) {
  const res = await db.query(
    `
        SELECT p.amount, p.status, p.paid_at, p.created_at
        FROM payments p
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC
        LIMIT 6
    `,
    [userId],
  );
  return res.rows;
}

// ---------------------------------------------------------
// MESSAGE BUILDERS
// ---------------------------------------------------------

function buildWelcomeMessage(name = "there") {
  return (
    `👋 *Hi ${name}, welcome to ${config.ispName}!* 🛰️\n` +
    `Fast & Reliable Starlink Hotspot Service.\n\n` +
    `How can we help you today?\n\n` +
    `1️⃣  🎟️ Buy Internet Ticket\n` +
    `2️⃣  📋 My Tickets (View My PINs)\n` +
    `3️⃣  💳 Payment History\n` +
    `4️⃣  📞 Contact Support\n\n` +
    `Reply with a number (1–4).\n\n` +
    `Need help with your hotspot connection or payment?\n` +
    `💬 WhatsApp / Phone: *${config.supportPhone}*\n\n` +
    (config.telegramBotHandle ? `\n\n✈️ Prefer Telegram? Chat at https://t.me/${config.telegramBotHandle}` : "")
  );
}

function buildAdminWelcomeMessage(name = "Admin") {
  return (
    `👋 *Hi ${name}!* 🛡️ *${config.ispName} Admin*\n\n` +
    `*📱 User Options:*\n` +
    `1️⃣  🎟️ Buy Internet Ticket\n` +
    `2️⃣  📋 My Tickets (View My PINs)\n` +
    `3️⃣  💳 Payment History\n` +
    `4️⃣  📞 Contact Support\n\n` +
    `*🛠️ Admin Commands:*\n` +
    `Type *!help* to see all admin commands.\n\n` +
    `Reply with a number (1–4) or an admin command.`
  );
}

function buildPlanMenu(plans) {
  let text = `📡 *${config.ispName} Hotspot Plans*\n\n`;
  text += plans
    .map((p, i) => {
      const devicesLabel = (p.shared_users > 1 && !p.name.includes("Device")) ? ` (${p.shared_users} Devices)` : "";
      return `${EMOJI_NUMS[i] || i + 1}  *${p.name}*${devicesLabel} — ₦${Number(p.price).toLocaleString()}`;
    })
    .join("\n");
  text += `\n\nReply with the plan number (1–${plans.length}), or *0* to go back.`;
  return text;
}

// ---------------------------------------------------------
// MAIN MESSAGE HANDLER
// ---------------------------------------------------------

export async function handleMessage(platform, remoteId, pnJid, text, pushName = null, db) {
  if (!text) return;

  if (platform === "whatsapp" && !remoteId.endsWith("@s.whatsapp.net") && !remoteId.endsWith("@lid")) {
    return;
  }

  const message = text.trim();
  const msgLower = message.toLowerCase();

  const phone = pnJid.split("@")[0];
  const user = await upsertUser(db, phone, pushName);
  const session = await getSession(db, phone);
  const firstName = (user.name || pushName || "there").split(" ")[0];

  const isAdmin = config.adminPhones.includes(phone);

  // Admin command check
  if (isAdmin) {
    const handled = await handleAdminMessage(platform, remoteId, phone, text, db);
    if (handled) return;
  }

  // Universal reset
  if (["hi", "hello", "menu"].includes(msgLower)) {
    await updateSession(db, phone, "awaiting_service_selection", null, platform, remoteId);
    const welcome = isAdmin ? buildAdminWelcomeMessage(firstName) : buildWelcomeMessage(firstName);
    await sendMessage(phone, welcome);
    return;
  }

  switch (session.state) {
    // ──────────────────────────────────────────────────────────────────
    // MAIN MENU: awaiting_service_selection
    // ──────────────────────────────────────────────────────────────────
    case "start":
    case "awaiting_service_selection": {
      if (message === "1") {
        // Buy Ticket
        const plans = await getAllPlans(db);
        await updateSession(db, phone, "awaiting_plan_selection", null, platform, remoteId);
        await sendMessage(phone, buildPlanMenu(plans));
      } else if (message === "2") {
        // My Tickets
        const tickets = await getUserTickets(db, user.id);
        if (!tickets.length) {
          await sendMessage(
            phone,
            `📋 *No Tickets Found*\n\nYou haven't purchased any hotspot tickets yet.\n\nReply *1* to buy your first ticket!`,
          );
        } else {
          let list = `🎟️ *Your Hotspot Tickets:*\n\n`;
          tickets.forEach((t, i) => {
            const date = new Date(t.created_at).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
            });
            list += `${i + 1}. Login PIN: \`${t.pin}\`\n   Plan: *${t.plan_name}* (₦${Number(t.price).toLocaleString()})\n   Purchased: ${date}\n\n`;
          });
          list += `📶 *How to Connect:*\nConnect to Wi-Fi (*${config.hotspotSsid}*), open *${config.portalUrl}*, and enter your Login PIN in the box to connect!`;
          await sendMessage(phone, list);
        }
      } else if (message === "3") {
        // Payment History
        const payments = await getPaymentHistory(db, user.id);
        if (!payments.length) {
          await sendMessage(phone, `💳 *Payment History*\n\nNo payment records found on your account.`);
        } else {
          let list = `💳 *Payment History*\n\n`;
          payments.forEach((p, i) => {
            const date = new Date(p.created_at).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
            });
            list += `${i + 1}. ₦${Number(p.amount).toLocaleString()} — ${p.status.toUpperCase()} (${date})\n`;
          });
          await sendMessage(phone, list);
        }
      } else if (message === "4") {
        // Support
        await sendMessage(
          phone,
          `📞 *${config.ispName} Support*\n\n` +
          `Need help with your hotspot connection or payment?\n\n` +
          `💬 WhatsApp / Phone: *${config.supportPhone}*\n` +
          `📶 Wi-Fi SSID: *${config.hotspotSsid}*\n` +
          `🌐 Login Portal: *${config.portalUrl}*\n\n` +
          `Send *HI* to return to the main menu.`,
        );
      } else {
        // await sendMessage(phone, `Please reply with a valid option (*1–4*), or send *HI* to reset.`);
        await sendMessage(phone, buildWelcomeMessage(firstName));
      }
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // PLAN SELECTION: awaiting_plan_selection
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_plan_selection": {
      if (message === "0") {
        await updateSession(db, phone, "awaiting_service_selection", null, platform, remoteId);
        await sendMessage(phone, buildWelcomeMessage(firstName));
        return;
      }

      const position = parseInt(message, 10);
      const plans = await getAllPlans(db);

      if (isNaN(position) || position < 1 || position > plans.length) {
        await sendMessage(
          phone,
          `Please reply with a valid plan number (1–${plans.length}), or *0* to go back.`,
        );
        return;
      }

      const selectedPlan = plans[position - 1];

      await sendMessage(phone, `⏳ Generating your payment account for *${selectedPlan.name}*...`);

      try {
        const { txRef, accountNumber, accountName, bankName } =
          await createDynamicVirtualAccount(
            phone,
            selectedPlan.price,
            selectedPlan.name,
          );

        await db.query(
          `
            INSERT INTO payments (user_id, amount, provider, status, virtual_account_reference)
            VALUES ($1, $2, 'flutterwave', 'pending', $3)
          `,
          [user.id, selectedPlan.price, txRef],
        );

        await updateSession(
          db,
          phone,
          "awaiting_payment",
          selectedPlan.id,
          platform,
          remoteId,
        );

        await sendMessage(
          phone,
          `💳 *Payment Details*\n\n` +
          `📦 Plan: *${selectedPlan.name}*${selectedPlan.name.includes("Device") ? "" : ` (${selectedPlan.shared_users > 1 ? selectedPlan.shared_users + " Devices" : "Single Device"})`}\n` +
          `💰 Amount: *₦${Number(selectedPlan.price).toLocaleString()}*\n\n` +
          `🏦 Bank: *${bankName}*\n` +
          `👤 Account Name: *${accountName}*\n` +
          `🔢 Account Number: \`${accountNumber}\`\n\n` +
          `⏱ This dynamic account expires in *30 minutes*.\n` +
          `🎟️ Your *Login Ticket PIN* will be sent immediately upon payment confirmation!\n\n` +
          `Type *PAID* after sending, or *0* to cancel.`,
        );
      } catch (err) {
        console.error("Dynamic Virtual Account creation failed:", err);
        await sendMessage(
          phone,
          `❌ Couldn't generate a payment account right now. Please send *HI* to try again.`,
        );
      }
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // AWAITING PAYMENT: awaiting_payment
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_payment": {
      if (message === "0" || msgLower === "cancel") {
        await updateSession(db, phone, "awaiting_service_selection", null, platform, remoteId);
        await sendMessage(phone, `Payment cancelled.\n\n` + buildWelcomeMessage(firstName));
        return;
      }

      if (msgLower === "paid") {
        const paymentRes = await db.query(
          `SELECT * FROM payments WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
          [user.id],
        );
        const payment = paymentRes.rows[0];

        if (payment && session.plan_id) {
          const plan = await getPlan(db, session.plan_id);
          try {
            const check = await verifyVirtualAccountPayment(
              payment.virtual_account_reference,
              plan.price,
            );
            if (check.paid) {
              await fulfillPayment(db, user, check.amountPaid);
              return;
            }
          } catch (verifyErr) {
            console.error("Manual payment verification error:", verifyErr.message);
          }
        }

        await sendMessage(
          phone,
          `⏳ *Waiting for Bank Confirmation*\n\n` +
          `We have not detected your transfer yet. Bank transfers usually confirm within 15–60 seconds.\n\n` +
          `Our system will automatically deliver your ticket PIN as soon as your bank confirms it. You can also reply *PAID* in a moment to check again.`,
        );
        return;
      }

      // Default reassurance for other messages while awaiting payment
      await sendMessage(
        phone,
        `⏳ *Payment Pending*\n\n` +
        `Please make the transfer to the provided account number. As soon as it clears, your ticket PIN will be sent automatically!\n\n` +
        `Reply *PAID* to check status or *0* to cancel.`,
      );
      break;
    }

    default: {
      await updateSession(db, phone, "awaiting_service_selection", null, platform, remoteId);
      await sendMessage(phone, buildWelcomeMessage(firstName));
      break;
    }
  }
}
