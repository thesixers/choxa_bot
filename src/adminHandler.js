import { 
  provisionHotspotUser, 
  removeHotspotUser, 
  removeActiveSessions, 
  buildMikrotikComment,
  getMikrotikClient,
  getHotspotUser,
  updateHotspotUser,
  removeHotspotCookies,
  resolveDurationStr 
} from "./mikrotik.js";
import { generateUniquePin } from "./fulfillPayment.js";
import { sendMessage } from "./messaging.js";
import config from "./config.js";

const adminSessions = new Map();
const PAGE_SIZE = 5;

function fmt(date) {
  return new Date(date).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function sanitizePhone(phone) {
  let cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    cleaned = "234" + cleaned.slice(1);
  }
  return cleaned;
}

export async function handleAdminMessage(platform, remoteId, from, text, db) {
  const raw = text.trim();
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // ── Multi-step session handling (e.g. !ticket wizard) ───────────────────
  const session = adminSessions.get(from);
  if (session && !cmd.startsWith("!")) {
    return handleAdminSession(from, raw, db, session);
  }

  // Cancel multi-step command
  if (cmd === "!cancel") {
    adminSessions.delete(from);
    await sendMessage(from, "❌ Action cancelled.");
    return true;
  }

  // ── Help Menu ──────────────────────────────────────────────────────────
  if (cmd === "!help" || cmd === "!admin") {
    await sendMessage(
      from,
      `🛠️ *Admin Panel — ${config.ispName}*\n\n` +
      `*Available Commands:*\n\n` +
      `🎟️ *!ticket* [plan_num] [phone]\n` +
      `   Generate & provision a ticket for cash customer\n\n` +
      `📊 *!stats*\n` +
      `   Overview: users, active tickets, revenue\n\n` +
      `🎫 *!tickets* [page]\n` +
      `   View recent tickets & PINs\n\n` +
      `👥 *!users* [page]\n` +
      `   Paginated list of users\n\n` +
      `🔍 *!user* <phone_or_pin>\n` +
      `   Look up user or ticket\n\n` +
      `💳 *!payments* [page]\n` +
      `   Recent payments log\n\n` +
      `⚡ *!kick* <pin>\n` +
      `   Kick active connection on MikroTik\n\n` +
      `🔓 *!resetmac* <pin>\n` +
      `   Clear locked MAC address (fix iOS/Android lockouts)\n\n` +
      `🍪 *!clearcookies* <pin>\n` +
      `   Purge all MAC cookies for a PIN\n\n` +
      `🗑️ *!delticket* <pin>\n` +
      `   Remove ticket from router & mark expired\n\n` +
      `📢 *!broadcast* <message>\n` +
      `   Send broadcast to all users\n\n` +
      `📅 *!daily* [today|yesterday|DD/MM/YYYY]\n` +
      `   Daily sales and revenue report\n\n` +
      `📡 *!profiles*\n` +
      `   List MikroTik profiles & check they match DB plans`,
    );
    return true;
  }

  // ── Stats ──────────────────────────────────────────────────────────────
  if (cmd === "!stats") {
    const [totalUsersRes, activeTicketsRes, revenueRes, pendingProvRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM users`),
      db.query(`SELECT COUNT(*) FROM subscriptions WHERE status = 'active' AND (expiry_time > NOW() OR expiry_time IS NULL)`),
      db.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'completed'`),
      db.query(`SELECT COUNT(*) FROM provisioning_queue WHERE status = 'pending'`),
    ]);

    await sendMessage(
      from,
      `📊 *${config.ispName} Stats*\n\n` +
      `👥 Total Users: *${totalUsersRes.rows[0].count}*\n` +
      `🎟️ Active Tickets: *${activeTicketsRes.rows[0].count}*\n` +
      `💰 Total Revenue: *₦${Number(revenueRes.rows[0].total).toLocaleString()}*\n` +
      `⚙️ Pending Provisions: *${pendingProvRes.rows[0].count}*`,
    );
    return true;
  }

  // ── Generate Ticket for Cash Customer ──────────────────────────────────
  if (cmd === "!ticket" || cmd === "!activate") {
    const planArg = parts[1];
    const phoneArg = parts[2];

    const plansRes = await db.query("SELECT * FROM plans ORDER BY price ASC, shared_users ASC");
    const plans = plansRes.rows;

    if (planArg) {
      const planIdx = parseInt(planArg, 10);
      if (planIdx >= 1 && planIdx <= plans.length) {
        const plan = plans[planIdx - 1];
        const cleanPhone = phoneArg ? sanitizePhone(phoneArg) : null;
        return executeGenerateTicket(from, plan, cleanPhone, db);
      }
    }

    // Interactive selection
    adminSessions.set(from, { step: "awaiting_plan", plans, defaultPhone: phoneArg });

    let msg = `🎟️ *Generate Cash Ticket*\n\nSelect a plan:\n\n`;
    plans.forEach((p, i) => {
      const dev = (p.shared_users > 1 && !p.name.includes("Device")) ? ` (${p.shared_users} Devices)` : "";
      msg += `${i + 1}. *${p.name}*${dev} — ₦${Number(p.price).toLocaleString()}\n`;
    });
    msg += `\nReply with plan number (1–${plans.length}), or type *!cancel*.\nOptionally add phone: e.g. "1 08012345678"`;

    await sendMessage(from, msg);
    return true;
  }

  // ── List Recent Tickets ────────────────────────────────────────────────
  if (cmd === "!tickets") {
    const page = Math.max(1, parseInt(parts[1], 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const res = await db.query(
      `
        SELECT DISTINCT ON (s.pin) s.pin, pl.name AS plan_name, pl.price, s.created_at, s.status, u.phone
        FROM subscriptions s
        JOIN plans pl ON pl.id = s.plan_id
        LEFT JOIN users u ON u.id = s.user_id
        ORDER BY s.pin, s.created_at DESC
      `,
    );

    // Sort and paginate in JS after deduplication
    const allRows = res.rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const total = allRows.length;
    const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
    const paginatedRows = allRows.slice(offset, offset + PAGE_SIZE);

    if (!paginatedRows.length) {
      await sendMessage(from, `No tickets found on page ${page}.`);
      return true;
    }

    let list = `🎫 *Hotspot Tickets (Page ${page}/${totalPages})*\n\n`;
    paginatedRows.forEach((r, i) => {
      const date = new Date(r.created_at).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      list += `${offset + i + 1}. PIN: \`${r.pin}\` — ${r.plan_name} (₦${Number(r.price).toLocaleString()})\n   📞 ${r.phone ? "+" + r.phone : "Walk-in"} • ${date} [${r.status}]\n\n`;
    });
    list += `Reply *!tickets ${page + 1}* for next page.`;
    await sendMessage(from, list);
    return true;
  }

  // ── Users List ─────────────────────────────────────────────────────────
  if (cmd === "!users") {
    const page = Math.max(1, parseInt(parts[1], 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const countRes = await db.query("SELECT COUNT(*) FROM users");
    const total = parseInt(countRes.rows[0].count, 10);
    const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

    const res = await db.query(
      `SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset],
    );

    let list = `👥 *Users (Page ${page}/${totalPages})*\n\n`;
    res.rows.forEach((u, i) => {
      list += `${offset + i + 1}. 📞 +${u.phone} (${u.name || "No name"})\n   Ticket PIN: \`${u.hotspot_username || "None"}\`\n\n`;
    });
    list += `Reply *!users ${page + 1}* for next page.`;
    await sendMessage(from, list);
    return true;
  }

  // ── Payments List ──────────────────────────────────────────────────────
  if (cmd === "!payments" || cmd === "!transactions") {
    const page = Math.max(1, parseInt(parts[1], 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const countRes = await db.query("SELECT COUNT(*) FROM payments");
    const total = parseInt(countRes.rows[0].count, 10);
    const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

    const res = await db.query(
      `
        SELECT p.id, p.amount, p.status, p.provider, p.method, p.created_at, p.paid_at, u.phone, u.name
        FROM payments p
        LEFT JOIN users u ON u.id = p.user_id
        ORDER BY p.created_at DESC
        LIMIT $1 OFFSET $2
      `,
      [PAGE_SIZE, offset],
    );

    if (!res.rows.length) {
      await sendMessage(from, `No payments found on page ${page}.`);
      return true;
    }

    let list = `💳 *Recent Payments (Page ${page}/${totalPages})*\n\n`;
    res.rows.forEach((p, i) => {
      const date = new Date(p.paid_at || p.created_at).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const statusIcon = p.status === "completed" ? "✅" : (p.status === "pending" ? "⏳" : "❌");
      list += `${offset + i + 1}. ₦${Number(p.amount).toLocaleString()} [${p.method || p.provider || "transfer"}] ${statusIcon} ${p.status.toUpperCase()}\n   📞 ${p.phone ? "+" + p.phone : "Walk-in"} • ${date}\n\n`;
    });
    list += `Reply *!payments ${page + 1}* for next page.`;
    await sendMessage(from, list);
    return true;
  }

  // ── User / Ticket Lookup ───────────────────────────────────────────────
  if (cmd === "!user") {
    const query = parts[1];
    if (!query) {
      await sendMessage(from, "Usage: *!user <phone_or_pin>*");
      return true;
    }

    const clean = query.replace(/\D/g, "");
    const res = await db.query(
      `
        SELECT u.*, s.pin, pl.name AS plan_name, s.status AS sub_status, s.created_at AS sub_date
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.id
        LEFT JOIN plans pl ON pl.id = s.plan_id
        WHERE u.phone LIKE $1 OR u.hotspot_username = $2 OR s.pin = $2
        ORDER BY s.created_at DESC LIMIT 1
      `,
      [`%${clean}%`, query],
    );

    if (!res.rows.length) {
      await sendMessage(from, `❌ No user or ticket found for "${query}".`);
      return true;
    }

    const u = res.rows[0];
    await sendMessage(
      from,
      `🔍 *User Details*\n\n` +
      `📞 Phone: *+${u.phone}*\n` +
      `👤 Name: *${u.name || "None"}*\n` +
      `🎟️ Latest PIN: \`${u.pin || u.hotspot_username || "None"}\`\n` +
      `📦 Plan: *${u.plan_name || "None"}* [${u.sub_status || "N/A"}]\n` +
      `📅 Registered: ${fmt(u.created_at)}`,
    );
    return true;
  }

  // ── Kick active session ────────────────────────────────────────────────
  if (cmd === "!kick") {
    const pin = parts[1];
    if (!pin) {
      await sendMessage(from, "Usage: *!kick <pin>*");
      return true;
    }

    const count = await removeActiveSessions(pin);
    await sendMessage(from, `⚡ Kicked ${count} active session(s) for PIN \`${pin}\`.`);
    return true;
  }

  // ── Reset Locked MAC Address ───────────────────────────────────────────
  if (cmd === "!resetmac") {
    const pin = parts[1];
    if (!pin) {
      await sendMessage(from, "Usage: *!resetmac <pin>*\n\nClears the locked MAC address so a customer can log in again from any device (use after iOS/Android MAC randomization lockout).");
      return true;
    }

    try {
      const mkUser = await getHotspotUser(pin);
      if (!mkUser || !mkUser[".id"]) {
        await sendMessage(from, `❌ PIN \`${pin}\` not found on MikroTik.`);
        return true;
      }

      const hadMac = mkUser["mac-address"] && mkUser["mac-address"] !== "";
      // Clear the mac-address field
      await updateHotspotUser(mkUser[".id"], { "mac-address": "" });
      // Also purge all MAC cookies so the customer gets a clean slate
      const cookieCount = await removeHotspotCookies(pin);

      await sendMessage(
        from,
        `✅ *MAC Reset Done*\n\n` +
        `🎟️ PIN: \`${pin}\`\n` +
        `${hadMac ? `🔓 Cleared locked MAC: \`${mkUser["mac-address"]}\`` : "ℹ️ No MAC was locked"}\n` +
        `🍪 Purged ${cookieCount} cookie(s)\n\n` +
        `Customer can now log in again from any device.`,
      );
    } catch (err) {
      await sendMessage(from, `❌ Failed to reset MAC: ${err.message}`);
    }
    return true;
  }

  // ── Purge MAC Cookies ──────────────────────────────────────────────────
  if (cmd === "!clearcookies") {
    const pin = parts[1];
    if (!pin) {
      await sendMessage(from, "Usage: *!clearcookies <pin>*\n\nPurges all MAC cookies for a PIN (use if a customer is stuck on a login loop or the cookie expired mid-plan).");
      return true;
    }

    try {
      const count = await removeHotspotCookies(pin);
      await sendMessage(from, `🍪 Cleared ${count} MAC cookie(s) for PIN \`${pin}\`. Customer will need to log in fresh.`);
    } catch (err) {
      await sendMessage(from, `❌ Failed to clear cookies: ${err.message}`);
    }
    return true;
  }

  // ── Delete / Revoke Ticket ─────────────────────────────────────────────
  if (cmd === "!delticket" || cmd === "!delsub") {
    const pin = parts[1];
    if (!pin) {
      await sendMessage(from, "Usage: *!delticket <pin>*");
      return true;
    }

    try {
      await removeActiveSessions(pin);
      await removeHotspotUser(pin);
      await db.query(`UPDATE subscriptions SET status = 'expired' WHERE pin = $1`, [pin]);
      await sendMessage(from, `🗑️ Ticket PIN \`${pin}\` removed from MikroTik and marked expired.`);
    } catch (err) {
      await sendMessage(from, `❌ Failed to delete ticket: ${err.message}`);
    }
    return true;
  }

  // ── Broadcast ──────────────────────────────────────────────────────────
  if (cmd === "!broadcast") {
    const broadcastMsg = parts.slice(1).join(" ");
    if (!broadcastMsg) {
      await sendMessage(from, "Usage: *!broadcast <message>*");
      return true;
    }

    const usersRes = await db.query("SELECT DISTINCT phone FROM users WHERE phone IS NOT NULL");
    let sent = 0;
    let failed = 0;

    for (const row of usersRes.rows) {
      try {
        await sendMessage(row.phone, `📢 *${config.ispName} Announcement*\n\n${broadcastMsg}`);
        sent++;
        await new Promise((r) => setTimeout(r, 400));
      } catch {
        failed++;
      }
    }

    await sendMessage(from, `📢 Broadcast complete.\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
    return true;
  }

  // ── Daily Report ───────────────────────────────────────────────────────
  if (cmd === "!daily") {
    const dateArg = parts[1] || "today";
    let targetDate = new Date().toLocaleDateString("en-CA");

    if (dateArg === "yesterday") {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      targetDate = y.toLocaleDateString("en-CA");
    } else if (dateArg.includes("/")) {
      const [dd, mm, yyyy] = dateArg.split("/");
      targetDate = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
      targetDate = dateArg;
    }

    const res = await db.query(
      `
        SELECT * FROM (
          SELECT DISTINCT ON (s.pin)
            s.pin,
            pl.name AS plan_name,
            pl.price,
            COALESCE(p.method, 'cash') AS method,
            s.created_at,
            u.phone
          FROM subscriptions s
          JOIN plans pl ON pl.id = s.plan_id
          LEFT JOIN users u ON u.id = s.user_id
          LEFT JOIN LATERAL (
            SELECT p.method
            FROM payments p
            WHERE (p.user_id = s.user_id OR (s.user_id IS NULL AND p.user_id IS NULL))
              AND p.status = 'completed'
            ORDER BY ABS(EXTRACT(EPOCH FROM (p.paid_at - s.created_at))) ASC
            LIMIT 1
          ) p ON true
          WHERE DATE(s.created_at) = $1
          ORDER BY s.pin, s.created_at DESC
        ) sub
        ORDER BY sub.created_at DESC
      `,
      [targetDate],
    );

    if (!res.rows.length) {
      await sendMessage(from, `📅 No tickets sold on *${targetDate}*.`);
      return true;
    }

    let revenue = 0;
    let list = `📅 *Tickets Sold on ${targetDate}*\n\n`;
    res.rows.forEach((r, i) => {
      revenue += Number(r.price);
      list += `${i + 1}. PIN: \`${r.pin}\` — ${r.plan_name} (₦${Number(r.price).toLocaleString()}) [${r.method || "cash"}]\n`;
    });
    list += `\n💰 Total Sales: *₦${revenue.toLocaleString()}* (${res.rows.length} tickets)`;

    await sendMessage(from, list);
    return true;
  }

  // ── MikroTik Hotspot Profiles ──────────────────────────────────────────
  if (cmd === "!profiles") {
    try {
      const client = getMikrotikClient();
      const res = await client.get("/ip/hotspot/user/profile");
      const profiles = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);

      if (!profiles.length) {
        await sendMessage(from, "📡 No hotspot profiles found on the router.");
        return true;
      }

      // Also get what the DB plans expect
      const dbRes = await db.query(`SELECT DISTINCT mikrotik_profile FROM plans ORDER BY mikrotik_profile`);
      const dbProfiles = dbRes.rows.map((r) => r.mikrotik_profile).filter(Boolean);

      let msg = `📡 *MikroTik Hotspot Profiles*\n\n*On Router:*\n`;
      profiles.forEach((p) => {
        msg += `• \`${p.name}\`\n`;
      });

      msg += `\n*In DB Plans:*\n`;
      dbProfiles.forEach((p) => {
        const match = profiles.some((r) => r.name === p);
        msg += `• \`${p}\` ${match ? "✅" : "❌ NOT FOUND ON ROUTER"}\n`;
      });

      if (dbProfiles.some((p) => !profiles.some((r) => r.name === p))) {
        msg += `\n⚠️ *Fix:* Update plan profile names in DB or create missing profiles on the router to match exactly.`;
      }

      await sendMessage(from, msg);
    } catch (err) {
      await sendMessage(from, `❌ Could not fetch profiles from MikroTik: ${err.message}`);
    }
    return true;
  }

  // Catch unknown admin commands starting with "!" so they don't fall through to customer chat
  if (cmd.startsWith("!")) {
    await sendMessage(from, `❌ Unknown admin command \`${cmd}\`.\n\nType *!help* to see available commands.`);
    return true;
  }

  return false;
}

async function handleAdminSession(from, text, db, session) {
  if (session.step === "awaiting_plan") {
    const parts = text.trim().split(/\s+/);
    const planIdx = parseInt(parts[0], 10);
    const plans = session.plans;

    if (isNaN(planIdx) || planIdx < 1 || planIdx > plans.length) {
      await sendMessage(from, `Please enter a valid plan number (1–${plans.length}), or type !cancel.`);
      return true;
    }

    const plan = plans[planIdx - 1];
    const rawPhone = parts[1] || session.defaultPhone;
    const cleanPhone = rawPhone ? sanitizePhone(rawPhone) : null;

    adminSessions.delete(from);
    return executeGenerateTicket(from, plan, cleanPhone, db);
  }

  return false;
}

async function executeGenerateTicket(from, plan, cleanPhone, db) {
  try {
    const pin = await generateUniquePin(db);

    let userId = null;
    if (cleanPhone) {
      const userRes = await db.query(
        `INSERT INTO users (phone, name, hotspot_username, status)
         VALUES ($1, 'Customer', $2, 'active')
         ON CONFLICT (phone) DO UPDATE SET hotspot_username = $2, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [cleanPhone, pin],
      );
      userId = userRes.rows[0].id;
    }

    // 1. Record cash payment
    await db.query(
      `INSERT INTO payments (user_id, amount, status, provider, method, paid_at)
       VALUES ($1, $2, 'completed', 'admin_cash', 'cash', CURRENT_TIMESTAMP)`,
      [userId, plan.price],
    );

    // 2. Record subscription as unactivated (countdown begins on first login)
    await db.query(
      `INSERT INTO subscriptions (user_id, plan_id, pin, status, start_time, expiry_time)
       VALUES ($1, $2, $3, 'active', NULL, NULL)
       ON CONFLICT (pin) DO NOTHING`,
      [userId, plan.id, pin],
    );

    // 3. Provision on MikroTik with guaranteed limit-uptime
    const comment = buildMikrotikComment(cleanPhone, plan.name);
    const limitUptime = resolveDurationStr(plan);
    await provisionHotspotUser(pin, plan.mikrotik_profile, comment, limitUptime);

    // 4. Send to user if phone provided
    if (cleanPhone) {
      await sendMessage(
        cleanPhone,
        `🎉 *Your ${config.ispName} Ticket is Ready!*\n\n` +
        `📦 Plan: *${plan.name}*\n` +
        `🎟️ *Login PIN:* \`${pin}\`\n\n` +
        `📶 *How to Connect:*\n` +
        `1. Connect to Wi-Fi (*${config.hotspotSsid}*)\n` +
        `2. Open your browser (*${config.portalUrl}*)\n` +
        `3. Enter Login PIN: \`${pin}\` in the box\n` +
        `4. Tap Connect & enjoy! 🛰️\n\n` +
        `ℹ️ _Your plan starts counting once you log in._`,
        { sendToBoth: true },
      );
    }

    // 5. Confirm to Admin
    await sendMessage(
      from,
      `🎟️ *Ticket Generated Successfully!*\n\n` +
      `📦 Plan: *${plan.name}* (₦${Number(plan.price).toLocaleString()})\n` +
      `🔑 *Login PIN:* \`${pin}\`\n` +
      (cleanPhone ? `📱 Sent to: +${cleanPhone}\n` : "") +
      `✅ Provisioned on MikroTik (${plan.mikrotik_profile})\n` +
      `⏳ Countdown starts on user's first login.`,
    );
    return true;
  } catch (err) {
    console.error("Admin ticket generation error:", err.message);

    // Build a clean error message — never expose router internals to the chat
    let adminMsg = `❌ *Ticket generation failed.*\n\n`;

    if (err.message?.includes("not found on router")) {
      adminMsg += `⚙️ MikroTik profile mismatch.\nRun *!profiles* to check which profiles exist on the router and match them to your plans.`;
    } else if (err.message?.includes("provision") || err.message?.includes("MikroTik")) {
      adminMsg += `⚙️ Could not reach the MikroTik router. Check the VPN/tunnel and try again.`;
    } else {
      adminMsg += `🛠️ Internal error: ${err.message.split("\n")[0].substring(0, 120)}`;
    }

    await sendMessage(from, adminMsg);
    return true;
  }
}
