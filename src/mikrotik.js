import axios from "axios";
import config from "./config.js";

// Tested MikroTik RouterOS v7 REST API endpoints:
// /ip/hotspot/user?name=genesix - GET - it allows queries too
// /ip/hotspot/user - PUT - to create a new record it accpects json data
// /ip/hotspot/user/<userid> - DELETE - to delete a user
// /ip/hotspot/user/<userid> - PATCH - to update users details accepts json of the data to be updated

/**
 * Returns a configured axios instance targeting the MikroTik RouterOS HTTP REST API.
 */
export function getMikrotikClient() {
  const mk = config.mikrotik;
  const portSuffix = mk.port === 80 ? "" : `:${mk.port}`;
  const baseURL = `http://${mk.host}${portSuffix}/rest`;

  return axios.create({
    baseURL,
    auth: {
      username: mk.user,
      password: mk.pass,
    },
    timeout: 10000,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

/**
 * Builds the MikroTik comment string from plan and phone.
 * @param {string} phone
 * @param {string} planName
 * @returns {string}
 */
export function buildMikrotikComment(phone, planName) {
  const d = new Date();
  const dateStr = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const timeStr = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${config.ispName} - ${planName} - ${phone || "walkin"} - ${dateStr} ${timeStr}`;
}

/**
 * Resolves or formats the limit-uptime string for a plan (e.g. '1d 00:00:00' or '0d 01:00:00').
 * @param {object} plan
 * @returns {string|null}
 */
export function resolveDurationStr(plan) {
  if (plan?.duration_str && String(plan.duration_str).trim()) {
    return String(plan.duration_str).trim();
  }
  const days = Number(plan?.duration_days);
  if (days === 0.04 || plan?.name?.toLowerCase().includes("hour")) {
    return "0d 01:00:00";
  }
  if (!isNaN(days) && days > 0) {
    return `${Math.round(days)}d 00:00:00`;
  }
  return null;
}

/**
 * Calculates the wall-clock expiry Date given a plan and starting date.
 * @param {object} plan
 * @param {Date} [fromDate]
 * @returns {Date}
 */
export function calculateExpiryDate(plan, fromDate = new Date()) {
  const expiry = new Date(fromDate);
  const durStr = resolveDurationStr(plan);
  if (durStr && durStr.includes("01:00:00")) {
    expiry.setHours(expiry.getHours() + 1);
  } else {
    const days = Number(plan?.duration_days) || 1;
    expiry.setTime(expiry.getTime() + days * 24 * 60 * 60 * 1000);
  }
  return expiry;
}

/**
 * Generates a random 7-digit numeric login PIN (matching MikroTicket app).
 * @returns {string}
 */
export function generatePin() {
  return Math.floor(1000000 + Math.random() * 9000000).toString();
}

/**
 * Queries a Hotspot user by name/PIN.
 * Endpoint: GET /ip/hotspot/user?name=<username>
 * @param {string} username
 * @returns {Promise<object|null>} The user object with `.id`, or null if not found.
 */
export async function getHotspotUser(username) {
  const client = getMikrotikClient();
  try {
    const res = await client.get("/ip/hotspot/user", {
      params: { name: username },
    });
    if (Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0];
    }
    if (res.data && res.data.name === username) {
      return res.data;
    }
    return null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    console.warn(`⚠️ MikroTik HTTP: getHotspotUser '${username}' error:`, err.message);
    return null;
  }
}

/**
 * Fetches all hotspot users.
 * Endpoint: GET /ip/hotspot/user
 * @returns {Promise<Array>}
 */
export async function getAllHotspotUsers() {
  const client = getMikrotikClient();
  try {
    const res = await client.get("/ip/hotspot/user");
    return Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
  } catch (err) {
    console.error("❌ MikroTik HTTP: getAllHotspotUsers error:", err.message);
    return [];
  }
}

// In-memory cache for router profile names (refreshed every 10 minutes)
let _profileCache = null;
let _profileCacheAt = 0;
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Fetches all hotspot user profiles from the router, with caching.
 * @returns {Promise<Array<{name: string}>>}
 */
export async function getHotspotProfiles() {
  const now = Date.now();
  if (_profileCache && now - _profileCacheAt < PROFILE_CACHE_TTL_MS) {
    return _profileCache;
  }
  const client = getMikrotikClient();
  try {
    const res = await client.get("/ip/hotspot/user/profile");
    const profiles = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
    _profileCache = profiles;
    _profileCacheAt = now;
    return profiles;
  } catch (err) {
    console.warn("⚠️ MikroTik: could not fetch profiles:", err.message);
    return _profileCache || [];
  }
}

/**
 * Resolves a profile name to the exact case-sensitive name on the router.
 * If no match is found, throws a clear error.
 * @param {string} profileName
 * @returns {Promise<string>}
 */
async function resolveProfile(profileName) {
  const profiles = await getHotspotProfiles();
  if (!profiles.length) {
    // Cannot validate — use as-is and let router reject if wrong
    return profileName;
  }

  // 1. Exact match
  const exact = profiles.find((p) => p.name === profileName);
  if (exact) return exact.name;

  // 2. Case-insensitive match
  const loose = profiles.find((p) => p.name.toLowerCase() === profileName.toLowerCase());
  if (loose) {
    console.warn(`⚠️ MikroTik profile '${profileName}' matched as '${loose.name}' (case-insensitive).`);
    return loose.name;
  }

  // 3. Prefix match — handles MikroTik Ticket auto-generated names like
  //    'profile_DAY-se:-co:500-pr:-lu:7-...' where DB stores just 'DAY'
  const prefix = profiles.find(
    (p) => p.name.toLowerCase().startsWith(`profile_${profileName.toLowerCase()}`)
       || p.name.toLowerCase().startsWith(profileName.toLowerCase() + "-")
  );
  if (prefix) {
    console.warn(`⚠️ MikroTik profile '${profileName}' matched via prefix as '${prefix.name}'.`);
    return prefix.name;
  }

  const available = profiles.map((p) => p.name).join(", ");
  throw new Error(`MikroTik profile '${profileName}' not found on router. Available: ${available}`);
}

/**
 * Creates or updates a Hotspot ticket user via HTTP REST API.
 * In ticket mode, both username (name) and password are set to the ticket PIN.
 * Endpoint: PUT /ip/hotspot/user (creates new)
 * Endpoint: PATCH /ip/hotspot/user/<id> (updates existing)
 *
 * @param {string} pin - The generated Ticket PIN (used as both username and password)
 * @param {string} profileName - The MikroTik hotspot profile name (e.g. 'Hour', 'DAY', 'Week')
 * @param {string} [comment] - Optional comment (e.g. phone, plan, date)
 * @param {string} [limitUptime] - Optional limit-uptime (e.g. '1d 00:00:00' or '0d 01:00:00')
 * @returns {Promise<string>} The PIN provisioned
 */
export async function provisionHotspotUser(
  pin,
  profileName,
  comment = null,
  limitUptime = null,
) {
  const client = getMikrotikClient();

  // Resolve profile name to exact router name (case-insensitive, throws if missing)
  const resolvedProfile = await resolveProfile(profileName);

  const payload = {
    name: String(pin),
    // NOTE: No password set — the profile has no-password=true, meaning the
    // hotspot login page sends an empty password. Setting a password here
    // causes "Invalid username or password" even when the PIN is correct.
    server: config.mikrotik.hotspotServer,
    profile: resolvedProfile,
  };
  if (comment) payload.comment = comment;
  if (limitUptime) payload["limit-uptime"] = limitUptime;

  try {
    // PUT /ip/hotspot/user - create new record
    await client.put("/ip/hotspot/user", payload);
    console.log(`📡 MikroTik (HTTP): provisioned ticket PIN '${pin}' on profile '${resolvedProfile}'`);
  } catch (err) {
    const errMsg = err.response?.data?.detail || err.response?.data?.message || err.message || "";
    const errLower = errMsg.toLowerCase();

    // Only treat as "user already exists" if the error says so — NOT for profile errors
    const isUserExists =
      errLower.includes("already have") ||
      errLower.includes("duplicate") ||
      (err.response?.status === 409);

    if (isUserExists) {
      const existing = await getHotspotUser(pin);
      if (existing && existing[".id"]) {
        await client.patch(`/ip/hotspot/user/${encodeURIComponent(existing[".id"])}`, payload);
        console.log(`📡 MikroTik (HTTP): updated existing ticket PIN '${pin}' via PATCH`);
        return pin;
      }
    }

    console.error(`❌ MikroTik (HTTP) provision error:`, errMsg);
    throw err;
  }

  return pin;
}

/**
 * Updates a hotspot user's details.
 * Endpoint: PATCH /ip/hotspot/user/<userid>
 * @param {string} userId - The MikroTik internal `.id` (e.g. '*1')
 * @param {object} data - Fields to update (e.g. { profile: 'Week', comment: '...' })
 */
export async function updateHotspotUser(userId, data) {
  const client = getMikrotikClient();
  const res = await client.patch(`/ip/hotspot/user/${encodeURIComponent(userId)}`, data);
  return res.data;
}

/**
 * Removes a hotspot user from MikroTik via HTTP REST API.
 * Endpoint: DELETE /ip/hotspot/user/<userid>
 * Silently handles cases where user is already deleted.
 * @param {string} username - The ticket PIN / username to remove
 */
export async function removeHotspotUser(username) {
  const client = getMikrotikClient();
  try {
    const user = await getHotspotUser(username);
    if (!user || !user[".id"]) {
      console.warn(`⚠️ MikroTik (HTTP): user '${username}' not found — already removed`);
      return false;
    }
    await client.delete(`/ip/hotspot/user/${encodeURIComponent(user[".id"])}`);
    console.log(`🗑️ MikroTik (HTTP): deleted user '${username}' (id: ${user[".id"]})`);
    return true;
  } catch (err) {
    if (err.response?.status === 404) {
      console.warn(`⚠️ MikroTik (HTTP): user '${username}' already removed`);
      return false;
    }
    throw err;
  }
}

/**
 * Retrieves active hotspot sessions.
 * Endpoint: GET /ip/hotspot/active
 * @param {string} [username] - Optional filter for specific user PIN
 * @returns {Promise<Array>}
 */
export async function getActiveSessions(username = null) {
  const client = getMikrotikClient();
  try {
    let sessions = [];
    if (username) {
      try {
        const res = await client.get("/ip/hotspot/active", {
          params: { user: username },
        });
        const data = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
        sessions = data.filter((s) => s.user === username);
      } catch {
        // Fallback: fetch all active sessions and filter client-side
        const res = await client.get("/ip/hotspot/active");
        const data = Array.isArray(res.data) ? res.data : [];
        sessions = data.filter((s) => s.user === username);
      }
    } else {
      const res = await client.get("/ip/hotspot/active");
      sessions = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
    }
    return sessions;
  } catch (err) {
    console.warn("⚠️ MikroTik (HTTP): getActiveSessions error:", err.message);
    return [];
  }
}

/**
 * Removes all active hotspot sessions for a given ticket PIN from MikroTik.
 * Endpoint: DELETE /ip/hotspot/active/<sessionid>
 * @param {string} username - The ticket PIN whose sessions should be removed
 * @returns {Promise<number>} Number of active sessions kicked
 */
export async function removeActiveSessions(username) {
  const client = getMikrotikClient();
  try {
    const sessions = await getActiveSessions(username);

    if (!sessions.length) {
      console.log(`ℹ️ MikroTik (HTTP): no active session for '${username}' — skipping`);
      return 0;
    }

    for (const session of sessions) {
      if (session[".id"]) {
        await client.delete(`/ip/hotspot/active/${encodeURIComponent(session[".id"])}`);
      }
    }

    console.log(`⚡ MikroTik (HTTP): removed ${sessions.length} active session(s) for '${username}'`);
    return sessions.length;
  } catch (err) {
    console.warn(`⚠️ MikroTik (HTTP): removeActiveSessions failed for '${username}':`, err.message);
    return 0;
  }
}

/**
 * Fetches basic system resource & identity info via HTTP REST API.
 * Endpoint: GET /system/resource & GET /system/identity
 */
export async function getRouterInfo() {
  const client = getMikrotikClient();
  try {
    const [resRes, idRes] = await Promise.all([
      client.get("/system/resource"),
      client.get("/system/identity"),
    ]);
    const resource = Array.isArray(resRes.data) ? resRes.data[0] : resRes.data;
    const identity = Array.isArray(idRes.data) ? idRes.data[0] : idRes.data;
    return {
      identity: identity?.name || "MikroTik",
      uptime: resource?.uptime,
      version: resource?.version,
      cpuLoad: resource?.["cpu-load"],
      freeMemory: resource?.["free-memory"],
      totalMemory: resource?.["total-memory"],
    };
  } catch (err) {
    console.warn("⚠️ MikroTik (HTTP): getRouterInfo error:", err.message);
    return null;
  }
}
